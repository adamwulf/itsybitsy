# Agent Type Inheritance — Implementation Plan

## Goal

Support `inherits: <other-type-name>` in an agent type's YAML frontmatter. When resolving a type:

- **Scalar attributes** (`name`, `description`, `canSpawnChildren`, `spawnable`, `model`, `icon`, `instructionStyle`, `allowedPaths`, `markdownBody`): child overrides parent if *defined on the child*. Undefined on child → inherited from parent.
- **Permissions** (`permissions.allow`, `permissions.deny`): **merged** (concatenated + deduped) across the inheritance chain.
- **Circular inheritance**: must be detected and reported as a validation error; no runtime crash.

Scope: this is purely an **agent type resolution** change. The downstream consumers (`ib-commands.ts`, `coordinator.ts`, `session-start.ts`, `intercept-task.ts`) call `loadAgentType(name)` and use the returned `AgentType` record — if `loadAgentType` correctly returns the *resolved* type (fields merged along the chain), the consumers need **no changes**.

## Design decisions

### 1. Inheritance only applies to regular types

The existing `_all.md` and `_non_coordinator.md` layers are *still* merged in on top of the resolved type (for non-coordinator / every agent). `inherits:` is orthogonal to the existing layer system — it operates on a single resolved type, which the layer system then applies on top of.

In other words, the order of precedence stays:

1. `_all.md` (every agent)
2. `_non_coordinator.md` (if not coordinator)
3. **Resolved `<type>.md`** (← new: now recursively resolved via `inherits:`)

The layer files themselves (`_all`, `_non_coordinator`) **may** use `inherits:` too — there is no special case. They remain non-spawnable via `spawnable: false`.

### 2. Override semantics for each field

The child type's frontmatter either **defines** a field or **doesn't**. "Defined" means the YAML key is literally present in the frontmatter (even if its value is `""`, `[]`, or `false`). "Not defined" means the key is absent.

| Field | Merge strategy |
|---|---|
| `name` | child overrides if defined; otherwise inherited. (In practice every file has a `name` — this is mostly academic, but the rule is consistent.) |
| `description` | child overrides if defined |
| `canSpawnChildren` | child overrides if defined |
| `spawnable` | child overrides if defined |
| `model` | child overrides if defined (empty string → inherit — see "edge case" below) |
| `icon` | child overrides if defined |
| `instructionStyle` | child overrides if defined |
| `allowedPaths` | child overrides if defined (replacement, not merge — matches the current "present-but-empty `[]` = strict" semantics) |
| `markdownBody` | child overrides if **non-empty**; otherwise inherited |
| `permissions.allow` | concatenate chain then dedupe via Set |
| `permissions.deny` | concatenate chain then dedupe via Set |
| `inherits` | metadata only — never exposed on the resolved `AgentType` |

#### Edge case: `model`

`parseSimpleValue` returns `""` for an empty/quoted-empty string. The existing `loadAgentType` treats `""` as `undefined` for `model`. To stay consistent, "defined but empty-string" = not overriding (i.e. inherit). This matters only for `model` because other string fields don't have this fallback treatment.

#### Edge case: `markdownBody`

The current `loadAgentType` returns `body || undefined`. The inheritance rule: child's body wins if **non-empty**; otherwise parent's body is used. A child file that is pure frontmatter (no body) therefore inherits its parent's body verbatim — useful for tweaking permissions without redefining a long instruction template.

### 3. Chain resolution

`loadAgentType(name)` must walk the inheritance chain:

```
loadAgentType("researcher")
  → reads researcher.md, sees `inherits: worker`
  → recursively reads worker.md
  → merges (worker base ← researcher overrides)
  → returns AgentType
```

A missing parent in the chain (e.g. `inherits: nonexistent`) throws with the **parent** name in the message. The error path uses the same `Unknown agent type '<name>'` wording as a missing top-level type. Chain depth is bounded by the cycle check.

### 4. Circular detection

Tracked via a `Set<string>` of type names already visited on the current chain. If the next parent is already in the set, throw `Circular inheritance detected: <a> → <b> → <a>` (or a similar chain-visualized message). The list is passed down the recursion (not cloned per branch — a linear chain).

Self-inheritance (`inherits: <own-name>`) is the degenerate case and must also be rejected by the same mechanism.

### 5. Validation

`validateAllAgentTypes()` (run at `ib watch` startup) already walks every `*.md`. Add:

- Type check: `inherits` must be a string or absent. Arrays/objects/booleans → error.
- **Reachability**: resolving each type (by calling the resolver in validation-only mode, or by running `loadAgentType` inside a try/catch) must not throw. This catches both missing parents and cycles at startup rather than later at spawn time.

### 6. Non-goals

- **No multiple inheritance** (`inherits: [a, b]`). Single-parent only. If the user wants to combine types, they chain `inherits` through intermediate files — keeps merge semantics unambiguous and keeps the YAML parser simple.
- **No method/body composition** beyond "child replaces, empty child inherits". No "super" / no prepending — keep it simple.
- **No change to layer files**. `_all.md` and `_non_coordinator.md` keep their existing merge semantics applied *after* type resolution. Their `inherits:` is legal but unusual — we won't special-case it.
- **No persistence of inherited chain in `meta.json`**. Only the final resolved type name (already in `meta.agentType`) is persisted. The chain is resolved fresh on every session-start / permission read.

## Code changes

### `src/agent-types.ts`

1. **Extend `AgentType` interface**: no new field on the resolved record — `inherits` is a build-time concern only. (Optionally expose `inheritsFrom?: string[]` for debugging — not strictly needed; skip unless a reviewer asks.)
2. **Split `loadAgentType` into two functions**:
   - `loadAgentTypeRaw(name)` — existing single-file parse. Returns `{ frontmatter, body, definedKeys: Set<string> }`. `definedKeys` is the set of top-level YAML keys literally present in the file.
   - `loadAgentType(name)` — public API. Walks the chain starting at `name`, calls `loadAgentTypeRaw` for each, merges parent ← child per the rules in §2, returns an `AgentType`.
3. **`definedKeys` tracking**: `parseAgentTypeFile` needs to expose which top-level keys were present in the frontmatter (so the merger can tell "absent" from "present but falsy"). Extend the returned shape to `{ frontmatter, body, definedKeys: Set<string> }` — or derive `definedKeys` from `Object.keys(frontmatter)` since the parser only adds keys that appear in the source. **Simpler path**: use `Object.keys(frontmatter)`. Verified against the parser: it never synthesizes keys.
4. **Cycle detection**: recursive helper `resolveChain(name, visited: Set<string>): ResolvedLink[]`. Throws on cycles with a human-readable chain. Returns a root-first list of raw records; `loadAgentType` folds them left-to-right (root, then each descendant overrides).
5. **Missing-parent error**: wrap the inner `Bun.file(...).exists()` check — rethrow with context `"Type '<child>' inherits from unknown type '<parent>'"`.
6. **`validateAllAgentTypes`**: after the existing per-file validations, for each file call `loadAgentType(name)` and push any thrown error to the errors array. This gives reachability/cycle checks for free.
7. **`listSpawnableTypeNamesSync`**: unchanged — still reads the file directly. A type that *inherits* `spawnable: false` but does not restate it on itself is still spawnable (because the lightweight sync scan only looks at its own frontmatter). This is the correct behavior: `spawnable` is not about hiding layer files behind inheritance, it's about a file being a layer itself. Document this in a code comment.

### `src/agent-types.test.ts`

New tests (outline):

- Parses `inherits:` from frontmatter.
- Child inherits missing scalar fields from parent.
- Child overrides defined scalar fields.
- `permissions.allow` merges across chain.
- `permissions.deny` merges across chain.
- Deduplicates duplicate permission entries.
- Multi-level chain (A → B → C) merges correctly.
- `markdownBody` inherits when child has empty body.
- `markdownBody` overrides when child has non-empty body.
- `allowedPaths` is replaced (not merged) when child defines it.
- `model: ""` on child inherits parent's model (edge case).
- Missing parent throws with parent name in message.
- Self-cycle (A inherits A) throws "Circular inheritance".
- Two-node cycle (A → B → A) throws.
- Three-node cycle (A → B → C → A) throws.
- `validateAllAgentTypes` flags circular type files.
- `validateAllAgentTypes` flags missing parent.
- `validateAllAgentTypes` flags non-string `inherits` value.

### Other files

- **`src/ib-commands.ts`**: no changes — already calls `loadAgentType(typeName)`. Permission assembly at L1673-1676 continues to work because resolved type now has merged permissions.
- **`src/coordinator.ts`**: no changes. `buildPerRepoCoordinatorSettings()` uses hardcoded lists — it doesn't call `loadAgentType` for coordinator.md. (Though it could, to honor coordinator.md inheritance — see "Open question" below.)
- **`src/hooks/session-start.ts`**: no changes. Already calls `loadAgentType(ctx.agentType)`.
- **`src/hooks/intercept-task.ts`**: no changes. Already calls `loadAgentType(meta.agentType)`.

### Docs / SPEC

- `SPEC.md` §2.3: add a bullet that type files may declare `inherits: <parent>` and that resolution produces a merged view (override on scalars, union on permissions).
- `SPEC.md` §2.6: document the `inherits` frontmatter field.
- `docs/agent-types/README.md`: mention inheritance briefly.

## Open question for the reviewer

`coordinator.ts:buildPerRepoCoordinatorSettings()` explicitly loads `_all` and merges it in, but **does not** load `coordinator.md` — its allow list is hardcoded. Should inheritance changes touch this path so that `coordinator.md`'s `inherits:` chain is honored for per-repo coordinators too? I lean **no for this PR** — the hardcoded coordinator permission path is a separate design decision, and expanding scope invites regressions. Flag this as a follow-up if the team wants it.

## Risks

1. **`Object.keys(frontmatter)` false negatives**: if the parser ever injects synthetic keys, `definedKeys` would be wrong. Mitigation: code-read the parser once to confirm it only adds user-authored keys. (Confirmed on a first read: the parser only writes to `frontmatter[key]` where `key` comes from the input line.)
2. **Performance**: resolving a chain re-parses each file. Chains are small and files are tiny (<2KB), so this is fine. No cache needed for v1.
3. **Layer files using `inherits:`**: `_all.md` could inherit from a user-authored base. This works as specified — layer file frontmatter is resolved the same way, merged result wins. Mention in a comment but don't special-case.
4. **Test isolation**: existing tests share `~/.itsybitsy/agent-types/` via `process.env.HOME`. New tests must also point to a temp HOME. Match existing `beforeEach/afterEach` pattern in `describe("initAgentTypes")`.

## Acceptance criteria

- `bun test` passes (all 1471+ existing tests, plus new ones).
- `bunx tsc --noEmit` reports zero errors.
- Authoring `researcher.md` with `inherits: worker` and extra `permissions.allow` produces a resolved type whose permissions include worker's + researcher's entries, deduped.
- Cycle or missing parent surfaces at `ib watch` startup, not as a spawn-time crash.

---

# Part 2 — Per-Type Repo Restriction (`repos:` field)

## Goal

Add a new YAML frontmatter field `repos:` (comma-separated string OR YAML list of strings) on an agent type. When present, `ib new-agent --type <type>` may only be used in a repo whose display name is in the list. Agents spawned against a non-matching repo are rejected with a clear error.

## Semantics

- `repos` **absent** (current behavior for every file): type can be spawned in any registered repo. No restriction.
- `repos` **present** (non-empty list): the root repo basename (and nickname, if set) must appear in the list. If neither matches, `ib new-agent` errors out with a message like:
  `Error: agent type 'researcher' is restricted to repos [muse-ios, muse-mac]; current repo 'itsybitsy' is not in that list`
- `repos` **present but empty** (`repos: []`): interpret as "no repos allowed — effectively unspawnable anywhere". This mirrors the `allowedPaths: []` = strict interpretation. Document clearly and include a test.

### Matching rule

A repo **matches** if its display name (nickname-or-basename, per `repoDisplayName()`) equals any entry in `repos`, OR its raw basename `name` equals any entry. Matching against both `name` and `nickname` removes a footgun when users rename repos.

Case-sensitive match (matches `repos.json` storage). Whitespace around each entry is trimmed.

### Inheritance interaction

`repos` follows the same **override** rule as other scalar fields: if the child defines `repos`, child wins; otherwise inherit from parent. **Not merged** — restriction is a child's explicit opt-in/out. This avoids surprising widening (e.g., a parent with `repos: [a]` being silently overridden by a child that doesn't mention it — actually that case should inherit, which is fine).

Rationale: if a user wants broader access in a child, they either redefine `repos:` explicitly or drop the parent's restriction by setting `repos:` to an explicit list. The rule is consistent.

### YAML parsing

Two accepted forms, matching existing conventions:

```yaml
repos: [muse-ios, muse-mac]
```

or

```yaml
repos:
  - muse-ios
  - muse-mac
```

The existing `parseAgentTypeFile` already handles both. No parser change required.

A third form — a single string `repos: muse-ios` — should be **rejected at validation time** (consistent error). We do not quietly coerce a bare string to a single-element list; it would hide typos like `repos: muse-ios, muse-mac` (which YAML reads as the string `"muse-ios, muse-mac"`, not a list).

## Code changes

### `src/agent-types.ts`

1. Extend `AgentType`:
   ```ts
   export interface AgentType {
     // ...existing fields...
     /** If defined, this type can only be spawned in repos whose name or nickname is in this list. */
     repos?: string[];
   }
   ```
2. In `loadAgentType` (after the inheritance resolver is in place), parse `repos` like `allowedPaths`:
   - Absent: `repos = undefined`
   - Array: keep as-is, trim each entry, drop non-string entries
   - Present but not array: validation error (see below)
3. In `validateAllAgentTypes`: if `frontmatter.repos !== undefined && !Array.isArray(frontmatter.repos)` → push error `"repos must be a list of strings"`. For non-string list entries, push analogous error.

### `src/ib-commands.ts` (`newAgent`)

After `agentTypeDef = await loadAgentType(typeName)` (around line 1468), before the coordinator-mode branch:

```ts
if (agentTypeDef.repos !== undefined) {
  const repos = await listRepos();
  const matchName = basename(rootRepoPath);
  const entry = repos.find(r => r.path === rootRepoPath);
  const display = entry ? repoDisplayName(entry) : matchName;
  const allowed = new Set(agentTypeDef.repos.map(s => s.trim()).filter(Boolean));
  const ok = allowed.has(matchName) || allowed.has(display);
  if (!ok) {
    return {
      ok: false, exitCode: 1, stdout: "",
      stderr: `Error: agent type '${typeName}' is restricted to repos [${[...allowed].join(", ")}]; current repo '${display}' is not in that list`,
    };
  }
}
```

`listRepos()` is already imported at L34 (via `registry`). `basename` is imported from `path` higher in the file.

This happens **before** the worktree/tmux spin-up so no cleanup is needed on rejection.

### SPEC + docs

- `SPEC.md` §2.6 table: add `repos` row.
- Brief note in `docs/agent-types/README.md`.

## Tests

New tests in `agent-types.test.ts`:

- `repos` absent → resolved `AgentType.repos === undefined`.
- `repos: [muse-ios]` → resolved `AgentType.repos === ["muse-ios"]`.
- `repos: []` → resolved `AgentType.repos === []`.
- `repos` inheritance: child without `repos` inherits parent's list.
- `repos` inheritance: child defines `repos` → overrides parent (not merged).
- Validation: `repos: "muse-ios"` (string, not list) fails validation.
- Validation: `repos: [1, 2]` fails with "entries must be strings".

New tests in `ib-commands.test.ts`:

- `newAgent` rejects when type's `repos` doesn't include the current repo basename.
- `newAgent` accepts when type's `repos` includes the basename.
- `newAgent` accepts when type's `repos` includes the nickname (not basename).
- `newAgent` rejects when `repos: []` (empty → no matches).
- `newAgent` allows any repo when `repos` is absent (regression guard).

## Edge cases + risks

1. **Unregistered repo** — `newAgent` accepts paths outside `repos.json` too (via `resolveGitRoot`). In that case `listRepos().find(...)` returns `undefined` and we fall back to `basename(rootRepoPath)`. If `repos` restriction names the basename, it still works. If the user relies on the nickname for matching, an unregistered repo can't satisfy it. Documented behavior — not a bug.
2. **Coordinator types with `repos:`** — coordinator types are spawned from the system coordinator or UI; they go through the same `newAgent` path, so the restriction applies uniformly. No special-casing needed.
3. **System coordinator** — the system coordinator session itself is not a regular agent (not created via `newAgent`); `repos` restrictions don't apply to it. Correct.
4. **Interaction with inheritance** — combining both features: `researcher inherits worker, repos: [muse-ios]` works. Validator must run inheritance resolution before checking `repos` shape (resolution preserves the override shape already). Add a test.

## Acceptance criteria (extended)

- Everything from Part 1 still passes.
- A type file with `repos: [a, b]` can only be spawned from repos matching `a` or `b`; otherwise `ib new-agent` errors out cleanly.
- Validator flags malformed `repos` at `ib watch` startup.

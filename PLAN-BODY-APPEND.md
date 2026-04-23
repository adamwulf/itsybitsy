# Plan — Change body inheritance from "replace" to "append"

## Change in a sentence

When a type inherits from another type, the final `markdownBody` is the **concatenation of every non-empty body in the chain**, joined with a blank line separator, **root-first**. Currently the rule is "child non-empty replaces parent; otherwise inherit parent."

## Motivation

`assistant.md` inherits from `manager.md`. The assistant body needs to include both the manager's boilerplate (bash rules, git worktree, workflow, agent states, merging) AND the assistant-specific content (role, toolkit, playbooks). With the current replace-on-non-empty rule, the assistant can only have one or the other. With append, the ancestor body lands first (manager boilerplate), then each descendant's body is appended in order (assistant additions).

## Rule

```
resolvedBody = chain
  .map(entry => entry.body)
  .filter(body => body.trim().length > 0)
  .join("\n\n");
```

- Root (oldest ancestor) body comes first.
- Each descendant's body appears below its parent's.
- Empty bodies in the chain are skipped (don't produce extra blank lines).
- Final resolved body is either a non-empty string or `undefined` (matching existing `body || undefined` convention in `buildAgentTypeFromFrontmatter`).

### Examples

**assistant ← manager:**
```
<manager body: bash rules, git worktree, commands, state management, ...>

<assistant body: role, toolkit, playbooks>
```

**C ← B ← A** (A has body, B has empty body, C has body):
```
<A body>

<C body>
```
(B skipped because its body is empty after trim.)

**C ← B ← A** (all three have bodies):
```
<A body>

<B body>

<C body>
```

## Interaction with existing layer-prefix system

`src/hooks/session-start.ts:202-221` already prepends `_all` and `_non_coordinator` layer bodies before the type body:

```
[_all] \n\n [_non_coordinator?] \n\n [typeBody]
```

Under the new rule, `typeBody` is already the chain-concatenation. Final order becomes (with `ancestor1` = root, `ancestorN` = immediate parent):

```
[_all] \n\n [_non_coordinator?] \n\n [ancestor1 (root)] \n\n ... \n\n [ancestorN] \n\n [child]
```

This is the right shape: layers outside the type chain come first, then the chain runs root-first. No change needed to `session-start.ts`.

## Interpolation

The existing `interpolateTemplate(agentType.markdownBody, ctx)` call (session-start.ts:217) runs on the already-concatenated body. Each ancestor's `{{agentId}}`, `{{parentBranch}}`, etc. get the child's context values — same as today for the single-body case. No per-ancestor interpolation needed; one pass over the joined body gives the same output.

## Code changes

### `src/agent-types.ts`

One function changes: `mergeRawFrontmatters`.

**Current body loop** (src/agent-types.ts roughly in `mergeRawFrontmatters`):
```ts
// Body — descendant body replaces when non-empty after trim.
if (entry.body.trim().length > 0) {
  body = entry.body;
}
```

**New body loop:**
```ts
// Body — concatenate every non-empty body in root-first order with a
// blank line between each. This makes descendants inherit and extend
// ancestor bodies rather than replace them.
const bodyParts: string[] = [];
for (const entry of chain) {
  if (entry.body.trim().length > 0) {
    bodyParts.push(entry.body);
  }
}
body = bodyParts.join("\n\n");
```

No inner `.trim()`: `parseAgentTypeFile` already trims the body at src/agent-types.ts:187, so `entry.body` arrives with no leading or trailing whitespace. Re-trimming would be redundant and misleading (would imply it guards against some unnormalized input path).

Everything else in `mergeRawFrontmatters` stays identical — scalars still override, permissions still Set-union.

### `{{#if}}` block boundaries

A handlebars-style `{{#if cond}}...{{/if}}` block is resolved by `interpolateTemplate` in session-start.ts:147 on the **concatenated** body. If a user splits an `{{#if}}` block across an ancestor boundary (opening tag in ancestor, closing tag in child), the interpolator still sees a balanced pair and resolves it. But it's confusing authoring and silently couples two files. This is an **authoring footgun**, not a spec hole — document it in `docs/agent-types/README.md` so users know each file should keep its `{{#if}}` blocks self-contained.

### Tests — updates in `src/agent-types.test.ts`

Two existing tests encode the old "replace" behavior and will need updating:

1. `"markdownBody inherits when child body is empty"` — still passes (empty child body joins nothing, so result == parent body). No change needed.
2. `"markdownBody overrides when child body is non-empty"` — **needs to flip** to assert append, not replace. Rename to `"markdownBody appends child body after parent body when both non-empty"`.
3. Multi-level chain test `"multi-level chain (A -> B -> C) merges and overrides correctly in order"` — currently asserts `type.markdownBody === "body A"`. With append, expected becomes `"body A"` still (B and C have empty bodies in that fixture). Verify the fixture really has empty B/C bodies and tweak expectations if not.

### Tests — additions in `src/agent-types.test.ts`

Add 3 new tests:

- **Parent body + child body append in order**: parent has body "P", child has body "C", resolved body is `"P\n\nC"`.
- **Three-level chain concatenates root-first**: A="A", B="B", C="C" → `"A\n\nB\n\nC"`.
- **Empty ancestors are skipped**: A="A", B="" (empty), C="C" → `"A\n\nC"` (no extra blank line from B).
- **Trim normalization**: A="A\n\n" (trailing blanks), child="\n\nB" (leading blanks) → result is `"A\n\nB"` (no quadruple blank line).

### Tests — update in `src/hooks/session-start.test.ts` (if present)

If any session-start test fixture relies on the current replace behavior with an inheriting type, update it. Grep for `inherits:` in test files to find fixtures.

### Docs

- **`SPEC.md` §2.2 table**: update the `markdownBody` row. Currently:
  > Inheritable — child replaces when its body is non-empty after trim; otherwise inherits the parent's body.

  New wording:
  > Inheritable — the final body is the **concatenation** of every non-empty body in the inheritance chain, root-first, joined by blank lines. Empty bodies in the chain are skipped.

- **`docs/agent-types/README.md`**: update the "Inheriting from another type" section. The current paragraph says "The markdown body inherits from the nearest ancestor whose body is non-empty" — replace with a description of the append behavior and add an example showing the `researcher.md` body appearing after `worker.md`'s body.

- **`PLAN-INHERITS.md`**: this is a historical plan document that informed the original implementation. I'll leave it alone (it describes what was built at that time). The new plan document is this file.

## Migration / compat

- No code change outside `agent-types.ts` and tests/docs. `session-start.ts` and `ib-commands.ts` see the same `markdownBody` string — its content is just richer now.
- Behavior change is observable: any existing type with `inherits:` that expected "child body replaces parent" will now get parent-then-child in the prompt. Today in the repo, only the user's `assistant.md` uses `inherits:` (we just added it). The repo's own default types (`manager.md`, `worker.md`, `coordinator.md`, `_all.md`, `_non_coordinator.md`) do not inherit. No in-repo regression risk.
- A user-authored type with `inherits:` that relied on the old replace behavior will start seeing the parent body prepended. Documented; low-risk because the feature was added in this same branch.

## Acceptance criteria

- `bun test` passes (existing + new tests).
- `bunx tsc --noEmit` clean.
- `loadAgentType("assistant")` returns a `markdownBody` that contains both the manager boilerplate and the assistant prose, with manager content appearing first.
- SPEC.md and docs/agent-types/README.md reflect the append rule.
- PLAN-INHERITS.md's historical `markdownBody` rule is NOT edited in place (it describes the earlier decision; this plan supersedes it).

## Out of scope

- Reorganizing `assistant.md` to remove duplicated manager boilerplate — that's a content edit the user should make themselves once the feature is live, so they can review the prompt shape.
- Any change to the `_all` / `_non_coordinator` layer prepending in session-start.
- Any merge-strategy option (e.g. "prepend" vs "append" per file) — keep it simple: always ancestor-first.

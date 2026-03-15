# Review A: Add question ID to `ib questions` CLI output

**Verdict: APPROVE**

## Summary

Single-line change in `src/index.ts:440` that adds the question `id` to the `ib questions` output, changing the format from:

```
[repo] agent-abc123 [acknowledged]
```

to:

```
[repo] agent-abc123 (question-id) [acknowledged]
```

## Criteria

### Clarity
The output format is clear and intuitive. The ID is parenthesized to visually separate it from the agent name and status tag. This directly supports the `ib ack <question-id>` workflow — previously, users had no way to discover the question ID from `ib questions` output.

### Conciseness
Minimal change — one line modified, no unnecessary code added.

### Security
`q.id` comes from the filename of a question file in `.ittybitty/agents/`. It is rendered via `console.log` template literal, which has no injection risk. No shell interpolation involved.

### Simplicity
One-line diff. About as simple as a change can get.

### Correctness
- The `PendingQuestion` interface already has an `id: string` field, so this is type-safe.
- All 1320 tests pass.
- TypeScript compiles with zero errors.
- The `--all` flag and `[acknowledged]` status tag continue to work correctly — the ID is inserted before the status tag, which reads naturally.

### CLAUDE.md / SPEC.md
No updates needed. This is a minor output formatting change to an existing CLI command, not a behavioral or architectural change.

## Issues

None.

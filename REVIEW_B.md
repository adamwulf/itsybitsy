# Review B: Add question ID to `ib questions` output

## Verdict: APPROVE

## Summary

Single-line change in `src/index.ts:440` adds the question ID to `ib questions` output:

```
# Before
[repo] agent-abc123
# After
[repo] agent-abc123 (question-id-here)
```

## Review Criteria

### Clarity
The output format `agent (id)` is clear and intuitive. The parenthetical placement keeps the ID visually distinct from the agent name without cluttering the output. This directly supports the `ib ack <question-id>` workflow — previously users had no way to discover question IDs from the CLI.

### Conciseness
One line changed, nothing extraneous.

### Security
`q.id` comes from the filesystem (question filenames under `.ittybitsy/agents/`). It's only used in `console.log` output, so no injection risk.

### Simplicity
Minimal change for the goal — exactly one template literal modified.

### Correctness
The ID is correctly placed after the agent name and before the `[acknowledged]` status tag. The `q.id` field exists on the `PendingQuestion` interface and is populated by `readPendingQuestions` / `readAllQuestions`. Works as intended.

### Docs
No CLAUDE.md or SPEC.md updates needed — this is a minor output format change with no architectural implications.

## Tests
- `bunx tsc --noEmit`: passes clean
- `bun test`: 1317 pass, 1 fail (pre-existing `nuke confirm` test unrelated to this change)

## Issues
None.

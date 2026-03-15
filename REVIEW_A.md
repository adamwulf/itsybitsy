---
review: A
commit: 46a797a
verdict: APPROVE
---

# Review A: Add question ID to 'ib questions' CLI output

## Verdict: APPROVE

## Summary

The commit adds the question ID in parentheses after the agent name in `ib questions` output, changing the format from:

```
[repo] agent-id [acknowledged]
```
to:
```
[repo] agent-id (question-uuid) [acknowledged]
```

## Correctness

- The change is a single-line modification in `src/index.ts:440`.
- `q.id` is a required `string` field on `PendingQuestion` (defined in `src/agents.ts:42`), so it is always present and never undefined.
- The `statusTag` (e.g., `[acknowledged]`) still appends correctly after the new `(id)` segment.
- No logic changes, no new branches, no risk of regression.

## Usefulness

- The question ID is needed to run `ib acknowledge <qid>` / `ib ack <qid>`. Previously, users had to look up the ID elsewhere. Now it's directly visible in the `ib questions` output, enabling a copy-paste workflow.
- Parenthesized format `(id)` visually distinguishes the ID from the agent name and the bracketed status tag, keeping the output scannable.

## Verification

- **Tests**: All 1320 tests pass (35 files, 4055 expect() calls).
- **Types**: `bunx tsc --noEmit` reports zero errors.

## Issues

None.

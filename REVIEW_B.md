# Review B: Add question ID to 'ib questions' CLI output

**Commit:** 46a797a — "Add question ID to 'ib questions' CLI output"
**Verdict:** APPROVE

## Summary

The change adds the question `id` field to the `ib questions` output line, changing:

```
[repo] agent-id [acknowledged]
```
to:
```
[repo] agent-id (q-1773552066-15c1d8) [acknowledged]
```

## Correctness

- `PendingQuestion.id` is a `string` field defined in `src/agents.ts:42` — always present.
- The interpolation `(${q.id})` is valid and matches the type.
- The `[acknowledged]` status tag still appends correctly after the ID.
- The format matches what `ib acknowledge <qid>` expects, making copy-paste easy.

## Format

- Parenthesized ID after the agent name is clear and non-ambiguous.
- Consistent with the help text: `acknowledge <qid>   Acknowledge a pending question`.

## Regressions

- **Tests:** 1320 pass, 0 fail.
- **TypeScript:** `bunx tsc --noEmit` reports zero errors.
- No other code paths affected (single line change in the `questions` case).

## Minor observations

- No issues found. The change is minimal, correct, and useful.

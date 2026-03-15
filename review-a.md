# Review A — Idle-at-prompt detection

## Summary

The change detects when an agent is sitting at a bare `❯` prompt (no typed text) with the Claude status bar visible, and classifies that as `waiting` instead of `unknown`. This is correct behavior — an idle prompt means the agent finished and is waiting for input.

## Verdict: APPROVE

All checks pass. One minor issue noted (duplicate fixtures) but not blocking.

## Detailed Findings

### 1. Regex correctness — PASS

```ts
/(^|\n)❯\s*($|\n)/.test(last15) && last15.includes("⏵⏵")
```

- `(^|\n)❯\s*($|\n)` correctly matches a line containing only `❯` plus optional trailing whitespace. It won't match `❯ what does HDA mean` because `\s*` is followed by `($|\n)` which requires end-of-string or newline — non-whitespace characters after `❯ ` prevent the match.
- The `⏵⏵` guard ensures the Claude status bar is visible, preventing false matches on `❯` in non-Claude contexts (e.g., shell prompt captured before Claude starts). Good design.

### 2. Priority placement — PASS

Placed at line 201, just before the `unknown` fallback. This is correct:

- Higher-priority checks (complete, WAITING, running, rate_limited, compacting, spinners, background tasks) all fire first. An agent that said `I HAVE COMPLETED THE GOAL` or `WAITING` and is now at the prompt will be caught by those checks, not this one.
- This only fires when no other pattern matched — meaning the agent is genuinely idle with no recognizable state signal. Classifying that as `waiting` is a strict improvement over `unknown`.

### 3. Test thoroughness — PASS (minor issue)

5 tests covering:
- **Positive**: bare `❯` with status bar → `waiting`
- **Negative**: `❯` with text after it → not `waiting`
- **Negative**: bare `❯` without status bar → `unknown`
- **Fixture 1**: real tmux snapshot → `waiting`
- **Fixture 2**: real tmux snapshot → `waiting`

**Minor issue**: `snapshot-idle-prompt-1.txt` and `snapshot-idle-prompt-2.txt` are byte-identical. Fixture 2 adds zero additional coverage. Either it should be removed, or it should contain a different idle-prompt scenario (e.g., shorter output, different model in status bar, no prior conversation history). Not blocking.

The fixture diff also removed 3 metadata header lines (`State: unknown` / `Reason: no patterns matched` / blank line) that were previously baked into the fixtures. This is correct — fixtures should contain raw tmux output, not expected-state metadata.

### 4. Existing pattern breakage risk — NONE

- No existing pattern uses `❯` or `⏵⏵` in a way that could conflict.
- The `background tasks` check (`/⏵⏵.*·\s[0-9]+\s/`) fires at higher priority and specifically matches `⏵⏵` followed by a task count pattern. An idle prompt won't have a task count, so no conflict.
- The `I HAVE COMPLETED THE GOAL` and `WAITING` checks remain higher priority, which is correct.

### 5. Build verification — PASS

- `bun test`: 1320 pass, 0 fail
- `bunx tsc --noEmit`: zero errors

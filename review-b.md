# Review B — Edge Case Analysis: Idle-at-Prompt Detection

**Reviewer:** agent-501e5a12 (Reviewer B)
**Branch:** Diff of `main...HEAD`
**Verdict:** APPROVE with minor suggestions

## Summary

The change adds idle-at-prompt detection to `parseState()`: a bare `❯` line (no text after it) combined with `⏵⏵` in the status bar returns `{ state: "waiting", reason: "idle at input prompt" }`. Two fixture files and five tests were added.

Tests pass: 1320/1320. TypeScript: zero errors.

## Edge Case Analysis

### 1. Could a `❯` inside agent output text false-positive?

**Low risk.** The regex `/(^|\n)❯\s*($|\n)/` requires `❯` at position 0 of a line with only whitespace after it. Claude Code's own output is indented under `⏺` markers, so any `❯` shown in agent responses (e.g., explaining shell prompts) would be indented and wouldn't match.

The fixtures themselves demonstrate `❯` with text after it (e.g., `❯ [hook]: ...`, `❯ what does HDA mean`) — these correctly don't match the bare-prompt regex.

The one scenario that could theoretically false-positive: if an agent's Claude Code output happens to render a bare `❯` at column 0 (not indented). This would be unusual since Claude Code indents all assistant output, but hook/watchdog messages DO render at column 0. A hook that outputs just `❯ ` with no payload could false-positive. This is extremely unlikely in practice.

### 2. What about `❯` in quoted text or code blocks?

**No risk.** Code blocks and quoted text in Claude Code output are always indented (prefixed with spaces under `⏺` markers). A `❯` inside a markdown code block would appear as something like `  ❯ ` — the leading spaces prevent the start-of-line match.

### 3. Is requiring both `❯` and `⏵⏵` sufficient to avoid false positives?

**Yes, effectively.** The dual requirement is good defense-in-depth, but the real protection comes from **priority ordering**: this check runs near the bottom of `parseState()` (line 201), after all active-execution checks (spinners, `(Esc to interrupt)`, `⎿  Waiting`, completion signals, `WAITING` markers, etc.). By the time we reach the idle-prompt check, we've already ruled out every known running/active/complete state.

The `⏵⏵` status bar is always visible at the Claude Code prompt, so it doesn't add much discrimination on its own — but it does correctly exclude raw tmux output that might contain `❯` without a Claude Code status bar (e.g., a non-Claude-Code tmux session).

One subtle correctness note: the fixture contains `I HAVE COMPLETED THE GOAL` at line 465, but this falls outside the `last15` window (lines ~472–486), so the completion check doesn't fire. This is **correct behavior** — after completing, the user asked a follow-up question ("what does HDA mean"), the agent answered it, and is now idle at the prompt again. `waiting` is the right state.

### 4. Should the fixture files have been trimmed further?

**Yes — minor issue.** The two fixture files are **byte-for-byte identical**. Tests `fixture snapshot-idle-prompt-1` and `fixture snapshot-idle-prompt-2` exercise the exact same input and provide zero additional coverage. Either:
- One fixture should be removed, or
- The second fixture should be a meaningfully different idle-prompt scenario (e.g., shorter output, different prompt context, no prior `I HAVE COMPLETED THE GOAL` in the scrollback)

Additionally, the fixtures are 488 lines each with extensive user-specific content (car research, agent IDs, warranty details). Only the last ~20 lines are relevant to idle-prompt detection. The fixtures could be trimmed to just the relevant tail, which would make the tests more focused and reduce fixture bloat. That said, full-length fixtures do provide value as integration-level regression tests.

### 5. Test coverage assessment

The synthetic tests are well-constructed:
- Bare `❯` with status bar → waiting (positive case)
- `❯` with text after it → NOT waiting (rejects non-empty prompt)
- Bare `❯` without status bar → unknown (rejects missing `⏵⏵`)

**Missing test cases to consider (non-blocking):**
- `❯` indented with spaces (e.g., `  ❯ `) + `⏵⏵` → should NOT match (verifies code block safety)
- `❯` with only a trailing newline vs. `❯` at the very end of input (boundary behavior)
- A scenario where `❯` appears in `last15` but is followed by `⏺` output (stale prompt from a resumed session)

## Conclusion

The implementation is correct and well-positioned in the priority chain. The dual `❯` + `⏵⏵` check with the low priority placement makes false positives extremely unlikely in practice. The only concrete issue is the duplicate fixture files providing no additional test coverage.

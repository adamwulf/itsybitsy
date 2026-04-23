# Task Plan — Whitelist Agent's Own Claude Projects Dir in Path-Check Hook

## Problem

Claude Code auto-spills oversized tool responses to:
`~/.claude/projects/<encoded-worktree-path>/<session-id>/tool-results/<tool>-<ts>.txt`

Our per-agent PreToolUse `hook-check-path` (`src/hooks/agent-path.ts`) currently denies any path outside the agent's own worktree + `agent.log` + `allowedPaths`. That blocks the agent from reading its own spilled tool output (observed in agent-90275746 transcript).

## Goal

Automatically allow each agent to access its own Claude project directory (`~/.claude/projects/<its-own-encoded-worktree>`) — treated as an implicit always-allowed path, just like `agent.log`. Other agents' project dirs stay denied by path mismatch.

## Scope of allowance

Allow the **whole project directory** for the current agent:
`~/.claude/projects/<encoded-worktree-path>/...`

Not just `tool-results/` — transcripts, metadata, and any subdirectories Claude Code writes there all belong to this agent. The encoded path is unique per agent worktree, so there's no overlap with other agents' project dirs. Narrower scoping (`*/tool-results/*`) would require knowing session IDs, and would produce surprising partial access.

Matching rule (mirrors `agent.log` and `isInAllowedPaths`): `filePath === projectDir || filePath.startsWith(projectDir + "/")`.

## Files touched

### 1. `src/hooks/agent-path.ts`
- In `checkFilePath()` (between step 7 / own `agent.log`, line ~263 and step 8 / other-agents block): insert a new step that allows the agent's own Claude project dir.
- Compute `claudeProjectDir` **inside `checkFilePath` on the fly** from `ctx.worktreePath` — no new `PathCheckContext` field. Pure string work, no I/O.
- **Extract a small helper `claudeProjectDirFor(worktreePath: string): string`** (exported) that returns the fully-resolved absolute project dir. This lets tests import and assert against the exact path the hook will compute, and centralizes the encoding-reuse comment.
- Import `encodeClaudeProjectPath` from `../auto-compact` — do NOT duplicate the encoding. Leave a one-line comment at the import site pointing to `src/auto-compact.ts` as the source-of-truth.
- Import `homedir` from `os`. Resolve `~/.claude/projects/<encoded>` via `join(homedir(), ".claude", "projects", encoded)`.
- **`realpathSync` the projectDir** (with try/catch for ENOENT — the dir may not exist yet) to handle the case where `~/.claude` is symlinked to another volume. Otherwise the inbound `filePath` (already realpath'd at agent-path.ts:252) won't prefix-match. Reviewer flagged this as the highest-probability miss.
- Canonicalise via `resolve()` first, then `realpathSync` best-effort.
- Allow reason string: `"Tool in allow list, accessing own Claude project dir"` — mirrors `agent.log` format (line 264) for greppability in `agent.log`.
- Edge: for `isNoWorktree` agents (coordinators), `worktreePath` is set to the repo root by `hookCheckPath` (line ~536). Coordinator would "own" `~/.claude/projects/<encoded-repo-root>` — acceptable, and their encoded path is unique per coordinator-repo pair.

### 2. `src/auto-compact.ts`
- **No behavioral change.** `encodeClaudeProjectPath` is already exported and is the single source of truth. Confirmed — we import, not duplicate.

### 3. `src/hooks/agent-path.test.ts`
Add a new `describe` block with cases:
- **Allow**: agent's own tool-results file (e.g. `<HOME>/.claude/projects/-repo-.../abc-session/tool-results/Read-123.txt`).
- **Allow**: agent's own transcript file directly under project dir.
- **Allow**: exact match on project dir path.
- **Deny (via allowedPaths:[])**: another agent's tool-results (different encoded path under `~/.claude/projects/`).
- **Deny (via allowedPaths:[])**: `~/.claude/projects/` root exactly.
- **Deny (via allowedPaths:[])**: a sibling dir whose name is a prefix of ours (e.g. `~/.claude/projects/<ours>-extra/...`) — confirms the `"/"` boundary guard.
- **Interaction with `allowedPaths: []` (strict mode)**: own project dir still allowed (new step runs *before* the allowedPaths gate, matching the `agent.log` precedent).
- **Interaction with `allowedPaths: [...]`**: own project dir allowed without needing an explicit entry.
- **Bash `cd` into own project dir under `allowedPaths: []`**: allowed (previously denied). Routes through `checkFilePath` via line 151 so it exercises the new step.
- **Coordinator edge** (`worktreePath === rootRepo`): own project dir allowed; pins that the helper handles the no-worktree case.
- Tests import the helper `claudeProjectDirFor()` (see file 1) to compute the expected `projectDir` — guarantees the test and hook compute identically. Tests use absolute `/Users/...`-style paths (what Claude Code actually sends); no reliance on `~` expansion.

### 4. `src/hooks/main-path.test.ts`
- **Not affected.** `main-path.ts` is the global hook for the *primary* Claude; it is not agent-scoped and has no project-dir logic. No test changes.

### 5. `SPEC.md` §6.1
- Update "Always allowed paths" (line ~646–648) to add a third bullet:
  - Agent's own Claude project directory (`~/.claude/projects/<encoded-worktree-path>/**`) — where Claude Code spills oversized tool responses and stores transcripts. Encoded via replacing `/` and `.` with `-` (see `src/auto-compact.ts::encodeClaudeProjectPath`).
- Step numbering: current SPEC prose says "steps 6–7" (always-allowed), "steps 8–9" (always-denied), "step 10" (allowedPaths). Code comments number through step 11 (legacy fallback).
- **New numbering**: always-allowed → steps 6–8, always-denied → 9–10, allowedPaths → 11, legacy fallback → 12.
- Update these spots:
  - `SPEC.md` §6.1 headings at the "Always allowed paths" line (change `steps 6–7` → `steps 6–8`), "Always denied paths" line (change `steps 8–9` → `steps 9–10`), "allowedPaths-based access control" line (change `step 10` → `step 11`).
  - `src/hooks/agent-path.ts` in-code numbered comments `// 6. Allow: path within worktree` … `// 11. Legacy fallback` accordingly.
- Do **not** disturb footnote anchors at SPEC.md:641 (`[^ts-only-bash-scan]`) and SPEC.md:644 (`[^ts-only-notebook-path]`).

## Placement & ordering reasoning

The new check belongs **between** "own agent.log" (step 7) and "other agents' directories" (step 8) because:
1. The Claude project dir is conceptually analogous to `agent.log` — an implicit per-agent resource outside the worktree.
2. Placing it before the denied-set and `allowedPaths` gate mirrors `agent.log`: the allowance survives strict mode (`allowedPaths: []`).
3. It's still below "own worktree" (step 6) so an agent pointing inside its own worktree never pays the projectDir computation.

## Cross-Cutting Review Checklist

Per CLAUDE.md's requirement to evaluate every change from four perspectives:

### 1. General agent functionality (session behavior)
- **Affected.** Agents will stop getting denials when reading their own tool-results files, which unblocks the observed bug (agent-90275746). No new capabilities granted beyond their own project dir.
- Legacy-permissive agents already had this access; for them the change is a no-op.

### 2. Hooks
- **Affected.** `hook-check-path` (`src/hooks/agent-path.ts`) gains a new allow step. No change to other hooks: `hook-status`, `hooks session-start`, `hooks intercept-task`, `hook-permission-denied`, or `hooks main-path`.
- `main-path` (primary Claude's global hook) is not agent-scoped and has no analogous logic — not affected.

### 3. Watchdog
- **Not affected.** Watchdog does not consult path-isolation rules. It monitors state, rate limits, and debounce nudges via `meta.json` / tmux output. No path-check interaction.

### 4. `ib watch` / dashboard
- **Not affected.** Dashboard reads `agent.log`, `meta.json`, `tmux capture-pane`, and transcript JSONL (for context usage). It does not invoke the path hook. The transcript-reading code in `auto-compact.ts` already uses `encodeClaudeProjectPath` — reusing that same helper in the hook keeps one source of truth. No dashboard behaviour changes.

## Reviewer verdict (agent-1cac800a, resolved)

Reviewer approved the plan's core approach. Feedback folded in above:
- Keep on-the-fly computation; extract `claudeProjectDirFor()` helper for test reuse.
- Whole-project-dir scope is correct.
- Add `realpathSync` on projectDir to handle symlinked `~/.claude`.
- Use reason string `"Tool in allow list, accessing own Claude project dir"`.
- Add Bash-cd-under-strict-mode test case and coordinator (`worktreePath === rootRepo`) test case.
- SPEC renumber must also update the prose ranges in §6.1 headings, not just code comments; don't disturb footnote anchors.
- Legacy-permissive concern correctly out of scope.
- Flagged (out-of-scope, acknowledged): encoded-path collision for weird worktree names (e.g. `/a/b` vs `/a.b` both encode to `-a-b`) — inherited from `auto-compact.ts`, not fixing here.

## Success criteria (from task prompt)

1. Agent can Read/grep/cat files under its own `~/.claude/projects/<its-encoded>/**/tool-results/*`. ✅ via new allow step.
2. Other agents' tool-results dirs remain denied. ✅ different encoded path won't prefix-match our `projectDir`; then denied by `allowedPaths: []` when strict, or by no-new-path-in-entry-list when entries defined.
3. `~/.claude/projects/` root denied (under strict / entry-based modes). ✅ not a prefix of our projectDir; falls to the existing rules.
4. Encoding reused from `auto-compact.ts`. ✅ import only.
5. Tests cover own allowed / other denied / root denied. ✅
6. `bun test` passes. ✅ gated by review cycle.
7. `bunx tsc --noEmit` clean. ✅ gated by review cycle.

## Concern / caveat flagged to reviewer

Success criterion #3 ("Agent CANNOT access `~/.claude/projects/` broadly") is only enforced today for agents with `allowedPaths: []` or an entry list that doesn't include `~/.claude`. Legacy-permissive agents (most existing agents) currently DO have access to `~/.claude/projects/` and sibling project dirs — that's pre-existing behavior, unchanged by this task. My take: out of scope. Flagging for reviewer confirmation.

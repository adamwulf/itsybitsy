# Review: Phases 42–44 Sidebar Layout, Focus System, and Coordinator

**Date:** 2026-03-15
**Reviewer:** Agent f6cfc337
**Scope:** PLAN.md (Phases 42–44, lines 1763–1991), CLAUDE.md updates, README.md updates

---

## Summary

The plan for sidebar layout (Phase 42), focus system (Phase 43), and coordinator session (Phase 44) is substantially complete and well-structured. Implementation steps are clear with appropriate dependencies. The plan aligns well with SPEC.md sections 11–13. Minor gaps exist around orphaned agent handling in the compact tree format, and one ambiguity about coordinator lifecycle ordering. File layout documentation is accurate and up-to-date.

---

## Approve / Reject

**APPROVE** with minor recommendations below.

The plan is ready to proceed. All three phases are implementable as specified, with clear success criteria and appropriate complexity levels. The dependencies form a logical progression (Phase 42 → Phase 43/44 in parallel → Phase 43d-e/44c-d together).

---

## Issues Found

### 1. **Phase 42b Missing Orphaned Agent Indicator**

**Location:** Phase 42b, Compact agent tree format section
**Severity:** Minor
**Description:**
The plan specifies the compact format as `icon agent-id  state  age` and mentions icon choices: "◆ (manager) or ⚙ (worker)". However, SPEC.md §11.3 explicitly states the icon includes "with ⚠ prefix if orphaned" (e.g., `⚠◆` or `⚠⚙`). The plan should explicitly call out orphaned agent handling in the checklist.

**Evidence:**
- SPEC.md §11.3: "Icon: ◆ (manager) or ⚙ (worker), with ⚠ prefix if orphaned"
- CLAUDE.md (agents.ts notes): `readAllAgents()` returns `orphanedTmuxSessions` — orphaned agents are a tracked concept
- Current plan (42b): No explicit checklist item for rendering `⚠` prefix

**Recommendation:** Add a bullet point or test case to 42b explicitly handling the ⚠ prefix for orphaned agents in compact mode.

---

### 2. **Phase 44c Coordinator Lifecycle Ordering Ambiguity**

**Location:** Phase 44c, Dashboard integration section
**Severity:** Minor (implementation detail)
**Description:**
The plan states: "On Ctrl-C exit: call `killCoordinatorSession()` after stopping the TUI". However, the sequence matters if the TUI is still attempting to poll or render the coordinator output during teardown. Is the correct order: (a) stop TUI rendering loop, then kill session? (b) kill session first, then stop TUI? (c) both in parallel with error suppression?

**Recommendation:** Add a sub-bullet clarifying the shutdown sequence, or defer this to implementation (since it's an optimization, not a correctness issue).

---

### 3. **CLAUDE.md Implementation Notes May Require Update**

**Location:** CLAUDE.md, "itsybitsy Implementation Notes" section
**Severity:** Cosmetic
**Description:**
The note says "All 6 phases complete. 968 tests across 28 files." This is accurate for the current state (before Phases 42–44). Once Phases 42–44 are implemented, this note should be updated to reflect the new file count and test count. Not urgent, but should be updated in the final commit.

**Recommendation:** Plan to update the test count and file count in CLAUDE.md after Phases 42–44 are complete.

---

## Suggestions

### 1. **Explicit Minimum Terminal Width Validation**

The plan mentions (in Phase 42e) "Minimum terminal width check: increase from 80 to 140 columns (60 sidebar + 80 main area minimum)". Consider adding a pre-render check and user-friendly error message if the terminal is too small, or gracefully degrade the layout (e.g., hide the sidebar if width < 120 cols). This isn't required by the spec but would improve UX on very small terminals.

### 2. **Coordinator Session Recovery**

Phase 44c mentions "Handle the case where the coordinator session dies mid-operation: show 'Coordinator stopped' in the panel, offer to restart". This is good UX. Consider adding a test case for this scenario (e.g., manually kill the coordinator session mid-watch and verify the UX response).

### 3. **Input Field Edge Cases**

Phase 43b's checklist should include test cases for: (a) submitting empty input (should it be a no-op or show an error?), (b) very long input lines (should they wrap in the input field or scroll horizontally?), (c) multi-byte UTF-8 characters (emoji, accents, CJK). The current plan doesn't explicitly address these.

### 4. **Focus Visual Indicators**

Phase 43c mentions "Focus visual indicator: highlight the focused panel's separator/header (bold or colored), dim unfocused panels". Consider documenting in the checklist exactly which ANSI attributes will be used (e.g., bold `\x1b[1m`, dim `\x1b[2m`, color codes) so the indicators are consistent with the rest of the TUI palette.

### 5. **Agent Tree Scroll Indicators**

Phase 42a mentions the sidebar agent tree "occupies up to 7 rows (same as the current `MAX_TREE_HEIGHT`), with scroll indicators if more rows exist". Confirm the scroll indicators match the existing format (probably `▲` / `▼` or similar) and are consistent with the current tree rendering.

---

## Checklist for Proceeding

- [ ] Phases 42–44 can proceed in the recommended parallelism order (42 → 43/44 parallel → 43d-e/44c-d together)
- [ ] All spec requirements (SPEC.md §11–13) are covered by the plan
- [ ] File layout is accurate (sidebar.ts, info-panel.ts, focus.ts, input-field.ts, coordinator.ts)
- [ ] Tests should be written for: orphaned agent icons, coordinator recovery, input edge cases, focus cycling, layout at various terminal sizes
- [ ] After implementation, update CLAUDE.md test count and file count

---

I HAVE COMPLETED THE GOAL

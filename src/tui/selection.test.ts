/**
 * Type-level tests for the Selection union (§17.3) — confirms the new
 * `{ kind: "team" }` variant is part of the discriminated union and narrows
 * correctly. These are compile-level assertions; a successful `tsc` is the gate.
 */

import { test, expect } from "bun:test";
import type { Selection } from "./selection";

test("a { kind: 'team' } value type-checks as a Selection (§17.3)", () => {
  const sel: Selection = { kind: "team", teamName: "backend" };
  // Discriminant-narrowing must surface teamName on the team branch.
  expect(sel?.kind).toBe("team");
  if (sel && sel.kind === "team") {
    expect(sel.teamName).toBe("backend");
  }
});

test("the existing Selection variants still type-check", () => {
  const variants: Selection[] = [
    { kind: "system-coordinator" },
    { kind: "repo-header", repoName: "r", repoPath: "/tmp/r" },
    { kind: "team", teamName: "frontend" },
    null,
  ];
  expect(variants.length).toBe(4);
});

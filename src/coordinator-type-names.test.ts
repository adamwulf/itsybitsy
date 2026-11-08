import { test, expect } from "bun:test";
import { REPO_COORDINATOR_TYPE, SYSTEM_COORDINATOR_TYPE, isCoordinatorType } from "./coordinator-type-names";

test("the coordinator type names match their type files", () => {
  // docs/agent-types/repo-coordinator.md and system-coordinator.md
  expect(REPO_COORDINATOR_TYPE).toBe("repo-coordinator");
  expect(SYSTEM_COORDINATOR_TYPE).toBe("system-coordinator");
});

test("isCoordinatorType matches only the two coordinator types", () => {
  expect(isCoordinatorType("repo-coordinator")).toBe(true);
  expect(isCoordinatorType("system-coordinator")).toBe(true);
  // The old type names, ordinary types, the layer file and no type at all.
  for (const name of ["coordinator", "system", "manager", "worker", "_non_coordinator", "", undefined]) {
    expect(isCoordinatorType(name)).toBe(false);
  }
});

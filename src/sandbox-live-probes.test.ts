import { expect, test } from "bun:test";
import { resolveLiveCapability } from "./sandbox-live-probes";

test("without the opt-in a prerequisite is not even checked", () => {
  for (const optIn of [undefined, "", "0", "true"]) {
    let checked = false;
    expect(resolveLiveCapability(optIn, () => { checked = true; })).toEqual({ state: "off" });
    expect(checked).toBe(false);
  }
});

test("with the opt-in a missing prerequisite is reported with its reason, not thrown", () => {
  expect(resolveLiveCapability("1", () => { throw new Error("cannot read kernel boot identity"); }))
    .toEqual({ state: "unavailable", reason: "cannot read kernel boot identity" });
});

test("with the opt-in a prerequisite that holds lets the probes run", () => {
  expect(resolveLiveCapability("1", () => {})).toEqual({ state: "available" });
});

import { test, expect, afterEach } from "bun:test";
import { homedir } from "os";
import { userHome, setUserHome, resetUserHome } from "./home";

// These tests mutate process.env.HOME directly to exercise the seam's fallback
// arms. Each case saves and restores the original value in a finally block, and
// the afterEach clears any test override, so nothing leaks between tests.
afterEach(() => {
  resetUserHome();
});

test("userHome returns the test override when set", () => {
  setUserHome("/tmp/fake-home");
  expect(userHome()).toBe("/tmp/fake-home");
});

test("userHome prefers process.env.HOME over homedir() when no override", () => {
  const original = process.env.HOME;
  try {
    process.env.HOME = "/tmp/env-home";
    expect(userHome()).toBe("/tmp/env-home");
  } finally {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
  }
});

test("userHome falls back to homedir() when HOME is empty", () => {
  const original = process.env.HOME;
  try {
    // Empty-string $HOME (env -i, systemd units, some sandboxes) must fall back
    // to homedir() — the seam uses `||`, not `??`, to guarantee this.
    process.env.HOME = "";
    expect(userHome()).toBe(homedir());
  } finally {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
  }
});

test("userHome falls back to homedir() when HOME is unset", () => {
  const original = process.env.HOME;
  try {
    delete process.env.HOME;
    expect(userHome()).toBe(homedir());
  } finally {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
  }
});

test("the override wins even over a set HOME", () => {
  const original = process.env.HOME;
  try {
    process.env.HOME = "/tmp/env-home";
    setUserHome("/tmp/override-home");
    expect(userHome()).toBe("/tmp/override-home");
  } finally {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
  }
});

test("resetUserHome clears the override", () => {
  const original = process.env.HOME;
  try {
    process.env.HOME = "/tmp/env-home";
    setUserHome("/tmp/override-home");
    resetUserHome();
    expect(userHome()).toBe("/tmp/env-home");
  } finally {
    if (original === undefined) delete process.env.HOME;
    else process.env.HOME = original;
  }
});

import { describe, expect, test } from "bun:test";
import { isBusyWaitBashCommand, isWaitAttempt, WAIT_HINT, withWaitHint } from "./wait-hint";

describe("isBusyWaitBashCommand", () => {
  test.each([
    "sleep 45",
    "   sleep 10",
    "sleep 0.5",
    "sleep 45; ib look agent-x",
    "sleep 5 && ib list",
    "until ib list | grep -q done; do sleep 5; done",
    "while true; do sleep 2; done",
    // Shape of the loops agents actually ran (Claude Code's own "use Monitor
    // with an until-loop" advice, sent to Bash instead).
    'until grep -qE "BUILD SUCCEEDED|BUILD FAILED" /tmp/build.log; do sleep 2; done; tail -5 /tmp/build.log',
  ])("matches %p", (command) => {
    expect(isBusyWaitBashCommand(command)).toBe(true);
  });

  test.each([
    "ib look agent-x",
    "grep sleep file.txt",
    "echo sleeping",
    "git status",
    "while read line; do echo $line; done < file",
  ])("does not match %p", (command) => {
    expect(isBusyWaitBashCommand(command)).toBe(false);
  });
});

describe("isWaitAttempt", () => {
  test("any Monitor call is a wait attempt", () => {
    expect(isWaitAttempt("Monitor", {})).toBe(true);
    expect(isWaitAttempt("Monitor", { command: "until test -f done; do sleep 2; done", description: "build" })).toBe(true);
  });

  test("a busy-wait Bash command is a wait attempt", () => {
    expect(isWaitAttempt("Bash", { command: "sleep 30" })).toBe(true);
  });

  test("ordinary Bash and other tools are not", () => {
    expect(isWaitAttempt("Bash", { command: "tail -5 /tmp/build.log" })).toBe(false);
    expect(isWaitAttempt("Bash", {})).toBe(false);
    expect(isWaitAttempt("Read", { file_path: "/tmp/build.log" })).toBe(false);
  });
});

describe("withWaitHint", () => {
  test("appends the hint to a wait attempt's deny reason", () => {
    expect(withWaitHint("Tool not in allow list", "Monitor", {}))
      .toBe(`Tool not in allow list — ${WAIT_HINT}`);
  });

  test("leaves other deny reasons unchanged", () => {
    expect(withWaitHint("Tool not in allow list", "WebFetch", { url: "https://x" }))
      .toBe("Tool not in allow list");
  });

  test("the hint points at WAITING, background commands, and sub-agents", () => {
    expect(WAIT_HINT).toContain("WAITING");
    expect(WAIT_HINT).toContain("run_in_background");
    // SPEC §8.5 / §8.5.1: the watchdog notifies on complete and waiting only.
    expect(WAIT_HINT).toContain("completes or needs input");
    expect(WAIT_HINT).not.toContain("state changes");
  });
});

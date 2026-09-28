import { describe, expect, test } from "bun:test";
import {
  COORDINATOR_WAIT_HINT,
  isBusyWaitBashCommand,
  isWaitAttempt,
  WAIT_HINT,
  waitHintFor,
  withWaitHint,
} from "./wait-hint";

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
    expect(withWaitHint("Tool not in allow list", "Monitor", {}, false))
      .toBe(`Tool not in allow list — ${WAIT_HINT}`);
  });

  test("a coordinator gets the coordinator hint", () => {
    expect(withWaitHint("Tool not in allow list", "Monitor", {}, true))
      .toBe(`Tool not in allow list — ${COORDINATOR_WAIT_HINT}`);
  });

  test("leaves other deny reasons unchanged", () => {
    expect(withWaitHint("Tool not in allow list", "WebFetch", { url: "https://x" }, false))
      .toBe("Tool not in allow list");
    expect(withWaitHint("Tool not in allow list", "WebFetch", { url: "https://x" }, true))
      .toBe("Tool not in allow list");
  });
});

describe("hint text", () => {
  test("the hint points at WAITING, background commands, and sub-agents", () => {
    expect(WAIT_HINT).toContain("WAITING");
    expect(WAIT_HINT).toContain("run_in_background");
    // SPEC §8.5 / §8.5.1: the watchdog notifies on complete and waiting only.
    expect(WAIT_HINT).toContain("completes or needs input");
    expect(WAIT_HINT).not.toContain("state changes");
    // Non-coordinator agent types are denied ScheduleWakeup.
    expect(WAIT_HINT).not.toContain("ScheduleWakeup");
  });

  // The watchdog is silent about an agent a coordinator started in another
  // repo, so the coordinator hint must not promise a notification for it.
  test("the coordinator hint says to schedule a check-in for other-repo agents", () => {
    expect(COORDINATOR_WAIT_HINT).toContain("WAITING");
    expect(COORDINATOR_WAIT_HINT).toContain("another repo");
    expect(COORDINATOR_WAIT_HINT).toContain("ScheduleWakeup");
    expect(COORDINATOR_WAIT_HINT).toContain("CronCreate");
  });

  test("waitHintFor picks the hint by role", () => {
    expect(waitHintFor(false)).toBe(WAIT_HINT);
    expect(waitHintFor(true)).toBe(COORDINATOR_WAIT_HINT);
  });
});

import { test, expect, describe } from "bun:test";
import { pushFailedNotice, pushFailureEntry, pushFailureNotice, pushRetryHint } from "./push-failure";

const REJECTED = [
  "To /remotes/origin.git",
  " ! [rejected]        main -> main (fetch first)",
  "error: failed to push some refs to '/remotes/origin.git'",
  "hint: Updates were rejected because the remote contains work that you do not",
  "hint: have locally.",
].join("\n");

describe("pushFailureEntry", () => {
  test("names the remote and indents git's later lines", () => {
    expect(pushFailureEntry("origin", "fatal: one\nsecond")).toBe("origin: fatal: one\n  second");
  });
});

describe("pushRetryHint", () => {
  test("names the machine only when one is given", () => {
    expect(pushRetryHint("app")).toBe("Run `ib push app` to push it.");
    expect(pushRetryHint("app", "Studio")).toBe("Run `ib push app` on Studio to push it.");
  });
});

describe("pushFailureNotice", () => {
  test("drops git's To <url> and hint: lines, keeping the rejection", () => {
    expect(pushFailureNotice(pushFailureEntry("origin", REJECTED))).toBe(
      "origin: ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to '/remotes/origin.git'",
    );
  });

  test("keeps one entry per remote", () => {
    const failure = [pushFailureEntry("origin", REJECTED), pushFailureEntry("upstream", "fatal: could not read from remote repository")].join("\n");
    expect(pushFailureNotice(failure)).toBe([
      "origin: ! [rejected]        main -> main (fetch first)",
      "error: failed to push some refs to '/remotes/origin.git'",
      "upstream: fatal: could not read from remote repository",
    ].join("\n"));
  });

  test("an entry with nothing but those lines keeps its full text", () => {
    expect(pushFailureNotice(pushFailureEntry("origin", "To /remotes/origin.git\nhint: retry"))).toBe(
      "origin: To /remotes/origin.git\nhint: retry",
    );
  });

  test("leaves a one-line failure as it is", () => {
    expect(pushFailureNotice("origin: fatal: could not read from remote repository")).toBe("origin: fatal: could not read from remote repository");
  });
});

describe("pushFailedNotice", () => {
  test("puts the summary first and the shortened failure after it", () => {
    expect(pushFailedNotice("Merged agent-abc", pushFailureEntry("origin", REJECTED))).toBe(
      "Merged agent-abc · push failed: origin: ! [rejected]        main -> main (fetch first)\nerror: failed to push some refs to '/remotes/origin.git'",
    );
  });
});

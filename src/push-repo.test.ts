import { test, expect, describe, afterEach } from "bun:test";
import { pushRepo, setPushSpawnRunner, resetPushSpawnRunner } from "./ib-commands";
import { makeSpawnResult } from "./test-utils";
import type { SpawnResult } from "./types";

// `ib push` and the push after `ib merge` (merge.pushAfterMerge, SPEC.md §3.4)
// share one push loop. These pin `ib push`'s own result through it. Every git
// call goes to a stubbed runner, so nothing is pushed anywhere.
describe("pushRepo", () => {
  const calls: string[][] = [];
  const envs: (NodeJS.ProcessEnv | undefined)[] = [];

  /** A repo with `main` and the given remotes; `git push` fails for each remote in `rejects`. */
  function stubRepo(remotes: string[], rejects: string[] = []) {
    calls.length = 0;
    envs.length = 0;
    setPushSpawnRunner((cmd: string[], opts): SpawnResult => {
      calls.push(cmd);
      envs.push(opts?.env);
      if (cmd.includes("show-ref")) return makeSpawnResult(cmd.at(-1) === "refs/heads/main" ? 0 : 1);
      if (cmd.includes("remote") && cmd.includes("-v")) {
        return makeSpawnResult(0, remotes.map((r) => `${r}\t/remotes/${r}.git (fetch)\n${r}\t/remotes/${r}.git (push)`).join("\n"));
      }
      if (cmd.includes("push")) {
        const remote = cmd[cmd.indexOf("push") + 1]!;
        return rejects.includes(remote)
          ? makeSpawnResult(1, "", "fatal: could not read from remote repository")
          : makeSpawnResult(0, "", `To /remotes/${remote}.git`);
      }
      return makeSpawnResult(1, "", `unexpected: ${cmd.join(" ")}`);
    });
  }

  afterEach(() => {
    resetPushSpawnRunner();
  });

  test("pushes main to every remote with one status line each", async () => {
    stubRepo(["origin", "upstream"]);

    const result = await pushRepo("/repo");

    // Exactly the command result: nothing from the shared loop leaks into it.
    expect(result).toEqual({
      ok: true, exitCode: 0, stderr: "",
      stdout: "✓ origin: pushed main\n  To /remotes/origin.git\n✓ upstream: pushed main\n  To /remotes/upstream.git",
    });
    expect(calls.filter((c) => c.includes("push"))).toEqual([
      ["git", "-C", "/repo", "push", "origin", "main"],
      ["git", "-C", "/repo", "push", "upstream", "main"],
    ]);
    // Run from a terminal, `ib push` may still prompt for credentials: only
    // the merge's push sets GIT_TERMINAL_PROMPT=0.
    expect(envs.every((env) => env === undefined)).toBe(true);
  });

  test("still tries every remote when one fails, and exits non-zero", async () => {
    stubRepo(["origin", "upstream"], ["origin"]);

    const result = await pushRepo("/repo");

    expect(result).toEqual({
      ok: false, exitCode: 1, stderr: "",
      stdout: "✗ origin: fatal: could not read from remote repository\n✓ upstream: pushed main\n  To /remotes/upstream.git",
    });
  });

  test("a repo without remotes is an error", async () => {
    stubRepo([]);

    const result = await pushRepo("/repo");

    expect(result).toEqual({ ok: false, exitCode: 1, stdout: "", stderr: "No remotes configured in /repo" });
  });
});

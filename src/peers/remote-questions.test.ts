import { expect, mock, test } from "bun:test";
import { acceptRemoteAcknowledge, type RemoteQuestionDeps } from "./remote-questions";

const ok = { ok: true, exitCode: 0, stdout: "Question acknowledged.", stderr: "" };

function fixture(repos = [{ name: "App", path: "/repos/app" }, { name: "lib", path: "/repos/lib" }]) {
  const logs: string[] = [];
  const deps = {
    listRepos: async () => repos,
    acknowledgeQuestion: mock<RemoteQuestionDeps["acknowledgeQuestion"]>(async () => ok),
    notice: mock((_line: string) => {}),
  } satisfies RemoteQuestionDeps;
  const accept = (repo: unknown, id: unknown, peer: string | null = "Laptop") =>
    acceptRemoteAcknowledge(repo, id, async () => peer, deps, line => logs.push(line));
  return { deps, logs, accept };
}

test("acknowledges in the repo matched by registry name, ignoring case, then logs and notices", async () => {
  const { deps, logs, accept } = fixture();
  await accept("app", "q-1");
  expect(deps.acknowledgeQuestion.mock.calls).toEqual([["/repos/app", "q-1"]]);
  expect(logs).toEqual(["Laptop acknowledged q-1 in App"]);
  expect(deps.notice.mock.calls).toEqual([["Laptop acknowledged q-1 in App"]]);
});

test("an unknown or ambiguous repo, or a malformed field, is refused before anything is written", async () => {
  const { deps, accept } = fixture([{ name: "App", path: "/a" }, { name: "APP", path: "/b" }, { name: "lib", path: "/c" }]);
  await expect(accept("app", "q-1")).rejects.toThrow("Repo is not uniquely registered on this machine");
  await expect(accept("other", "q-1")).rejects.toThrow("Repo is not uniquely registered on this machine");
  for (const repo of [7, "", "a/b", ".."]) await expect(accept(repo, "q-1")).rejects.toThrow("Invalid repo registry name");
  for (const id of [7, " ", "q-1\x1b[31m", "q‮1"]) await expect(accept("lib", id)).rejects.toThrow("Invalid question id");
  expect(deps.acknowledgeQuestion).not.toHaveBeenCalled();
  expect(deps.notice).not.toHaveBeenCalled();
});

test("pairing lost before the write is refused", async () => {
  const { deps, logs, accept } = fixture();
  await expect(accept("app", "q-1", null)).rejects.toThrow("Machine is no longer paired");
  expect(deps.acknowledgeQuestion).not.toHaveBeenCalled();
  expect(logs).toEqual([]);
});

test("a failed acknowledge fails with its stderr and notices nothing", async () => {
  const { deps, logs, accept } = fixture();
  deps.acknowledgeQuestion.mockResolvedValueOnce({ ok: false, exitCode: 1, stdout: "", stderr: "Question 'q-9' not found" });
  await expect(accept("app", "q-9")).rejects.toThrow("Question 'q-9' not found");
  expect(logs).toEqual([]);
  expect(deps.notice).not.toHaveBeenCalled();
});

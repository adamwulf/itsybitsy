/** The receiver of `{"op":"acknowledge"}` (SPEC §20.4): a paired dashboard acknowledges one of this machine's questions. */
import type { acknowledgeQuestion } from "../ib-commands";
import { isStoredRepoName, type listRepos } from "../registry";

export interface RemoteQuestionDeps {
  listRepos: typeof listRepos;
  acknowledgeQuestion: typeof acknowledgeQuestion;
  notice(message: string): void;
}

/**
 * Acknowledge question `id` in the registered repo `repo` (ignoring case), as
 * `ib acknowledge` does: an id already acknowledged is accepted again.
 */
export async function acceptRemoteAcknowledge(repo: unknown, id: unknown, readPeerName: () => Promise<string | null>, deps: RemoteQuestionDeps, log: (line: string) => void): Promise<void> {
  if (!isStoredRepoName(repo)) throw new Error("Invalid repo registry name");
  if (typeof id !== "string" || !id.trim() || /[\p{Cc}\p{Cf}]/u.test(id)) throw new Error("Invalid question id");
  const repos = (await deps.listRepos()).filter(entry => entry.name.toLowerCase() === repo.toLowerCase());
  if (repos.length !== 1) throw new Error("Repo is not uniquely registered on this machine");
  const entry = repos[0]!;
  const peer = await readPeerName();
  if (peer === null) throw new Error("Machine is no longer paired");
  const result = await deps.acknowledgeQuestion(entry.path, id);
  if (!result.ok) throw new Error(result.stderr);
  const notice = `${peer} acknowledged ${id} in ${entry.name}`;
  log(notice);
  deps.notice(notice);
}

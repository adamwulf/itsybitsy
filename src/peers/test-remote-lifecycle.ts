import { mock } from "bun:test";
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { agentsDir, archiveDir } from "../runtime-names";
import { makeAgent } from "../test-utils";
import type { RemoteLifecycleDeps } from "./remote-lifecycle";

/** Real registry lookup and archive layout, with mutations confined to fixture metadata. */
export async function lifecycleFixture(repo: string) {
  const active = join(agentsDir(repo), "worker");
  const archive = join(archiveDir(repo), "20261123-120000-worker");
  await Bun.write(join(active, "meta.json"), JSON.stringify(makeAgent({ id: "worker" }).meta));
  await mkdir(archiveDir(repo), { recursive: true });
  const ok = { ok: true, exitCode: 0, stdout: "", stderr: "" };
  return {
    listRepos: async () => [{ path: repo, name: "App" }],
    mergeCheckAgent: mock<RemoteLifecycleDeps["mergeCheckAgent"]>(async () => ({ ...ok, stdout: "Ready" })),
    mergeAgent: mock<RemoteLifecycleDeps["mergeAgent"]>(async () => ok),
    retireAgent: mock<RemoteLifecycleDeps["retireAgent"]>(async () => { await rename(active, archive); return ok; }),
    rehireAgent: mock<RemoteLifecycleDeps["rehireAgent"]>(async () => { await rename(archive, active); return ok; }),
    resumeAgent: mock<RemoteLifecycleDeps["resumeAgent"]>(async () => ok),
    detectAgentStates: mock<RemoteLifecycleDeps["detectAgentStates"]>(async () => {}),
    notice: mock((_line: string) => {}),
  } satisfies RemoteLifecycleDeps;
}

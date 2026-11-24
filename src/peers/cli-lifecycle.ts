import type { IbCommandResult } from "../ib-commands";
import { readMachineName } from "../machine-name";
import { listRepos } from "../registry";
import { resolveAgentTarget } from "../resolve-target";
import { handoffRemoteLifecycle } from "./peer-outbox";
import { parseLifecycleRequest, type RemoteLifecycleRequest } from "./remote-lifecycle";
import { remoteLifecycleDenial, remoteStartDenialAtStartup } from "./remote-start-caller";
import { readPeers } from "./store";

export const lifecycleCliCaller = { denial: remoteStartDenialAtStartup };

/** Local qualified addresses continue through the ordinary CLI and its watchdog routing. */
export async function routeQualifiedLifecycle(address: string, options: Pick<RemoteLifecycleRequest, "action" | "keep" | "force">): Promise<IbCommandResult | null> {
  const parts = address.split("/");
  const machine = parts[0]!;
  try {
    if (machine.toLowerCase() === (await readMachineName()).toLowerCase()) return null;
    const denial = await lifecycleCliCaller.denial();
    if (denial !== null) throw new Error(remoteLifecycleDenial(denial, options.action));
    if (parts.length < 2 || parts.length > 3 || parts.some(p => !p)) throw new Error(`Invalid agent address: ${address}`);
    if (options.action === "rehire") {
      // The active snapshot cannot resolve retirement archives. Resolve the
      // paired machine here and let its own registry resolve the id or nickname.
      const peers = (await readPeers()).filter(p => p.name.toLowerCase() === machine.toLowerCase());
      if (peers.length !== 1) throw new Error(`${peers.length ? "Ambiguous" : "Unknown"} machine: ${machine}`);
      return await handoffRemoteLifecycle(peers[0]!.id, peers[0]!.name, parseLifecycleRequest({
        ...options, id: parts.at(-1), repo: parts.length === 3 ? parts[1] : undefined,
      }));
    }
    const { remote, error } = await resolveAgentTarget(address, await listRepos(), process.cwd(), "lifecycle");
    if (!remote || remote.target.kind !== "agent" || !remote.target.repo) throw new Error(error ?? "Select a remote agent");
    return await handoffRemoteLifecycle(remote.peer, machine, { ...options, repo: remote.target.repo, id: remote.target.agent });
  } catch (err) {
    return { ok: false, exitCode: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  }
}

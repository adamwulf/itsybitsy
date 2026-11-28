import type { IbCommandResult } from "../ib-commands";
import { interruptedSend } from "../spawn-broker";
import { cleanMachineName, readMachineName } from "../machine-name";
import { listRepos } from "../registry";
import { resolveAgentTarget } from "../resolve-target";
import { handoffRemoteLifecycle } from "./peer-outbox";
import { parseLifecycleRequest, type RemoteLifecycleRequest } from "./remote-lifecycle";
import { remoteLifecycleDenial, remoteStartDenialAtStartup } from "./remote-start-caller";
import { cleanPeerName, readPeers } from "./store";

export const lifecycleCliCaller = { denial: remoteStartDenialAtStartup };

/** Local qualified addresses continue through the ordinary CLI and its watchdog routing. */
export async function routeQualifiedLifecycle(address: string, options: Pick<RemoteLifecycleRequest, "action" | "keep" | "force">): Promise<IbCommandResult | null> {
  const parts = address.split("/");
  // Compared, and reported, in clean form: `"MacBook Pro/repo/agent"` names
  // the machine `macbook-pro` (cleanMachineName, cleanPeerName).
  const machine = cleanMachineName(parts[0]!);
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  try {
    if (machine === await readMachineName()) return null;
    process.on("SIGINT", interrupt);
    const denial = await lifecycleCliCaller.denial();
    if (denial !== null) throw new Error(remoteLifecycleDenial(denial, options.action));
    if (parts.length < 2 || parts.length > 3 || parts.some(p => !p)) throw new Error(`Invalid agent address: ${address}`);
    if (options.action === "rehire") {
      // The active snapshot cannot resolve retirement archives. Resolve the
      // paired machine here and let its own registry resolve the id or nickname.
      const peers = (await readPeers()).filter(p => cleanPeerName(p) === machine);
      if (peers.length !== 1) throw new Error(`${peers.length ? "Ambiguous" : "Unknown"} machine: ${parts[0]}`);
      return await handoffRemoteLifecycle(peers[0]!.id, machine, parseLifecycleRequest({
        ...options, id: parts.at(-1), repo: parts.length === 3 ? parts[1] : undefined,
      }), controller.signal);
    }
    const { remote, error } = await resolveAgentTarget(address, await listRepos(), process.cwd(), "lifecycle");
    if (!remote || remote.target.kind !== "agent" || !remote.target.repo) throw new Error(error ?? "Select a remote agent");
    // The resolved peer's clean name is the typed segment's clean form.
    return await handoffRemoteLifecycle(remote.peer, machine, { ...options, repo: remote.target.repo, id: remote.target.agent }, controller.signal);
  } catch (err) {
    if (controller.signal.aborted) return interruptedSend("unpublished");
    return { ok: false, exitCode: 1, stdout: "", stderr: err instanceof Error ? err.message : String(err) };
  } finally { process.off("SIGINT", interrupt); }
}

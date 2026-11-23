import { sendMessage, type PeerEnqueueOptions } from "../ib-commands";
import { listRepos } from "../registry";
import { resolveAgentTarget } from "../resolve-target";
import { type SendHeader, type SendTarget } from "./send-frame";

export function targetLabel(target: SendTarget): string {
  if (target.kind === "system") return "@system";
  if (target.kind === "repo-coordinator") return "@" + target.repo;
  return target.repo ? target.repo + "/" + target.agent : target.agent;
}

async function enqueue(header: SendHeader, peerName: string, peerSend: PeerEnqueueOptions) {
  const fromAgent = header.from.kind === "agent" ? header.from.id :
    header.from.kind === "system" ? peerName + "/@system" : undefined;
  const opts = { fromAgent, peerSend };
  const target = header.target;
  if (target.kind === "system") {
    const { sendToSystemCoordinator } = await import("../index");
    return sendToSystemCoordinator(header.message, opts);
  }

  let repos = await listRepos();
  if (target.repo !== undefined) {
    const name = target.repo.toLowerCase();
    repos = repos.filter(repo => repo.name.toLowerCase() === name);
    if (repos.length !== 1) throw new Error(`Unknown or ambiguous repo: ${target.repo}`);
  }
  if (target.kind === "agent" && target.agent.includes("/")) throw new Error("Invalid agent target");
  const scoped = target.repo !== undefined;
  const address = target.kind === "repo-coordinator" ? "@coordinator" : target.agent;
  const resolved = await resolveAgentTarget(address, repos, scoped ? repos[0]!.path : "/", "agent", true);
  if (!resolved.agent) throw new Error(resolved.error ?? `Agent not found: ${targetLabel(target)}`);
  return sendMessage(resolved.agent, header.message, opts);
}

/** Shared across this watcher's inbound connections. Concurrent replays await the first enqueue. */
export function createMessageReceiver(log: (line: string) => void, notice: (line: string) => void, now = Date.now) {
  const accepted = new Map<string, number>();
  const pending = new Map<string, Promise<void>>();
  return async (header: SendHeader, peerId: string, readPeerName: () => Promise<string | null>) => {
    if (header.files.length) throw new Error("attachments are not supported yet");
    if (!header.message) throw new Error("Message is empty");
    const name = await readPeerName();
    if (name === null) throw new Error("not a peer");

    const key = peerId + ":" + header.id.toLowerCase();
    const time = now();
    for (const [id, expires] of accepted) if (expires <= time) accepted.delete(id);
    if (accepted.has(key)) return;
    const earlier = pending.get(key);
    if (earlier) return earlier;
    const work = async () => {
      const result = await enqueue(header, name, {
        log,
        senderKind: header.from.kind === "user" ? undefined : header.from.kind,
        async beforeEnqueue() {
          if (await readPeerName() === null) throw new Error("not a peer");
        },
      });
      if (!result.ok) throw new Error(result.stderr);
      accepted.set(key, now() + 600_000);
      const line = `${name} sent a message to ${targetLabel(header.target)}`;
      log(line);
      notice(line);
    };
    const task = work();
    pending.set(key, task);
    try { await task; } finally { pending.delete(key); }
  };
}

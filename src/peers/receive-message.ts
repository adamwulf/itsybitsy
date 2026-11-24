import { cleanRemoteText } from "./peer-link";
import { IDLE_TIMEOUT_MS } from "./transfer-limits";
import type { PairStream } from "./pairing";
import { sendMessage, type PeerEnqueueOptions } from "../ib-commands";
import { listRepos } from "../registry";
import { resolveAgentTarget } from "../resolve-target";
import { createAttachmentReceiver, fileSummary, type AttachmentReceiver, type ReceivedAttachments } from "./receive-attachments";
import { waitForIO, type FileBodyOptions, type SendHeader, type SendTarget } from "./send-frame";

export function targetLabel(target: SendTarget): string {
  if (target.kind === "system") return "@system";
  if (target.kind === "repo-coordinator") return "@" + target.repo;
  return target.repo ? target.repo + "/" + target.agent : target.agent;
}

async function enqueue(header: SendHeader, peerName: string, peerSend: PeerEnqueueOptions, options: FileBodyOptions) {
  const fromAgent = header.from.kind === "agent" ? header.from.id :
    header.from.kind === "system" ? peerName + "/@system" : undefined;
  const opts = { fromAgent, peerSend, noPassthrough: header.files.length > 0 || header.noPassthrough === true };
  const target = header.target;
  if (target.kind === "system") {
    const { sendToSystemCoordinator } = await import("../index");
    return sendToSystemCoordinator(header.message, opts);
  }

  let repos = await waitForIO(options, listRepos);
  if (target.repo !== undefined) {
    const name = target.repo.toLowerCase();
    repos = repos.filter(repo => repo.name.toLowerCase() === name);
    if (repos.length !== 1) throw new Error(`Unknown or ambiguous repo: ${target.repo}`);
  }
  if (target.kind === "agent" && target.agent.includes("/")) throw new Error("Invalid agent target");
  const scoped = target.repo !== undefined;
  const address = target.kind === "repo-coordinator" ? "@coordinator" : target.agent;
  const resolved = await waitForIO(options, () => resolveAgentTarget(address, repos, scoped ? repos[0]!.path : "/", "agent", true));
  if (!resolved.agent) throw new Error(resolved.error ?? `Agent not found: ${targetLabel(target)}`);
  return sendMessage(resolved.agent, header.message, opts);
}

/** Shared across this watcher's inbound connections. Concurrent replays await the first enqueue.
 * Dashboard and CLI submissions mint a new wire ID. No sender reopens a stream
 * for that ID, and claim recovery reports an unknown outcome without resending. */
export function createMessageReceiver(log: (line: string) => void, notice: (line: string) => void, now = () => performance.now(), capacity = 4096,
  attachments: AttachmentReceiver = createAttachmentReceiver(),
) {
  const accepted = new Map<string, number>();
  type Replay = (failure?: { error: unknown }) => void;
  const pending = new Map<string, Set<Replay>>();
  let waiters = 0;
  return async (header: SendHeader, peerId: string, readPeerName: () => Promise<string | null>,
    body?: Pick<PairStream, "read">, options: import("./peer-link").ReceiptOptions = {}) => {
    if (!header.message && !header.files.length) throw new Error("Message is empty");
    const name = await waitForIO(options, readPeerName);
    if (name === null) throw new Error("not a peer");

    const key = peerId + ":" + header.id.toLowerCase();
    const time = now();
    for (const [id, expires] of accepted) {
      if (expires > time) break;
      accepted.delete(id);
    }
    if (accepted.has(key)) return;
    const earlier = pending.get(key);
    if (earlier) {
      if (waiters >= 8) throw new Error("busy, try again");
      waiters++;
      const result = Promise.withResolvers<void>();
      const finish: Replay = failure => failure ? result.reject(failure.error) : result.resolve();
      const closed = () => result.reject(options.signal!.reason);
      const timeout = () => result.reject(new Error("still being received — outcome unknown"));
      const setTimer = options.setTimer ?? ((ms, fn) => {
        const timer = setTimeout(fn, ms); return () => clearTimeout(timer);
      });
      const cancel = setTimer(IDLE_TIMEOUT_MS, timeout);
      try {
        options.admitted?.(false);
        options.signal?.throwIfAborted();
        earlier.add(finish);
        options.signal?.addEventListener("abort", closed, { once: true });
        return await result.promise;
      } finally {
        cancel();
        options.signal?.removeEventListener("abort", closed);
        earlier.delete(finish);
        waiters--;
      }
    }
    if (accepted.size + pending.size >= capacity) throw new Error("busy, try again");
    const work = async () => {
      const { files } = header;
      await attachments(peerId, files, { peerName: name, log, notice, now }, async receive => {
        let staged: ReceivedAttachments | undefined;
        let bodyError: unknown;
        options.admitted?.(files.length > 0);
        const result = await enqueue(header, name, {
          log,
          signal: options.signal, setTimer: options.setTimer,
          senderKind: header.from.kind === "user" ? undefined : header.from.kind,
          prepareMessage: files.length ? async () => {
            if (!body) throw new Error("Missing attachment stream");
            try {
              staged = await receive(header.message, body, options);
              return staged.text;
            } catch (err) { bodyError = err; throw err; }
          } : undefined,
          async beforeEnqueue() {
            if (await waitForIO(options, readPeerName) === null) throw new Error("not a peer");
            options.signal?.throwIfAborted();
            options.committing?.();
            await staged?.commit();
          },
        }, options);
        if (!result.ok) throw bodyError ?? new Error(result.stderr);
      });
      accepted.set(key, now() + 600_000);
      const line = `${cleanRemoteText(name)} sent a message${fileSummary(files)} to ${cleanRemoteText(targetLabel(header.target))}`;
      log(line);
      notice(line);
    };
    const replays = new Set<Replay>();
    pending.set(key, replays);
    try {
      await work();
      for (const finish of replays) finish();
    } catch (error) {
      for (const finish of replays) finish({ error });
      throw error;
    } finally { pending.delete(key); }
  };
}

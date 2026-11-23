import { randomUUID } from "node:crypto";
import { renameSync, unlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { hasLiveEndpointOwner } from "./endpoint-lock";
import { PEER_POLL_INTERVAL_MS } from "./poller";
import { join } from "node:path";
import { peerDir } from "../runtime-names";
import type { PeerLinkState } from "./poller";

interface CachedAgent {
  repo: string;
  id: string;
  nickname: string | null;
  state: string;
}

export interface CachedPeer {
  name: string;
  id: string;
  connected: boolean;
  lastOkAt: number | null;
  agents: CachedAgent[];
}

const cachePath = () => join(peerDir(), "remote-agents.json");

/** Called by the endpoint lock owner. Synchronous replacement preserves poll order through shutdown. */
export function writeRemoteAgents(states: PeerLinkState[]): void {
  const peers: CachedPeer[] = states.map(({ name, id, connected, lastOkAt, agents }) => ({
    name, id, connected, lastOkAt,
    agents: (agents ?? []).map(({ repoRegistryName: repo, id, nickname, state }) => ({ repo, id, nickname, state })),
  }));
  const path = cachePath();
  const tmp = path + "." + randomUUID() + ".tmp";
  try {
    writeFileSync(tmp, JSON.stringify(peers), { flag: "wx", mode: 0o600 });
    renameSync(tmp, path);
  } finally {
    try { unlinkSync(tmp); } catch { /* renamed, or creation failed */ }
  }
}

export async function readConnectedPeers(requireVisibility = false): Promise<CachedPeer[]> {
  try {
    const file = await open(cachePath(), "r");
    let peers;
    try {
      if (!await hasLiveEndpointOwner((await file.stat()).mtimeMs, 3 * PEER_POLL_INTERVAL_MS)) return [];
      peers = JSON.parse(await file.readFile("utf8"));
    } finally { await file.close(); }
    if (!Array.isArray(peers)) return [];
    return peers.filter((p) => p?.connected === true && typeof p.name === "string" &&
      Array.isArray(p.agents) && p.agents.every((a: CachedAgent) =>
        typeof a?.id === "string" && typeof a.repo === "string"));
  } catch (err) {
    if (requireVisibility && ["EPERM", "EACCES"].includes((err as NodeJS.ErrnoException).code ?? "")) throw err;
    return [];
  }
}

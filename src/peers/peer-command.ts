/**
 * `ib peer id|list|remove|attach` (docs/plans/iroh-peering.md, "CLI (v1)";
 * SPEC.md §20.4 for attach).
 *
 * None of these load the iroh addon: `id` derives the public key with
 * node:crypto (identity.ts), `list`/`remove` only read and write
 * peers.json (store.ts), and `attach` talks to the endpoint-owning `ib watch`
 * over its local socket (attach-command.ts). peer-command.test.ts makes the
 * addon loader throw to prove it. Pairing happens only in `ib watch`; there
 * is no `ib peer add`.
 *
 * Every `ib peer` subcommand is human-only: the PreToolUse hook
 * (checkIbCommandAccess in src/hooks/agent-path.ts) denies `ib peer` to every
 * agent session.
 */

import { ATTACH_USAGE, runAttach } from "./attach-command";
import { loadOrCreatePeerId } from "./identity";
import { readPeers, removePeer, type Peer } from "./store";

export const PEER_USAGE =
  "Usage: ib peer <id|list|remove|attach> ...\n" +
  "  ib peer id\n" +
  "  ib peer list\n" +
  "  ib peer remove <name|id>\n" +
  `  ${ATTACH_USAGE.replace("Usage: ", "")}`;

function pad(text: string, width: number): string {
  return text + " ".repeat(Math.max(0, width - Bun.stringWidth(text)));
}

function printPeers(peers: Peer[]): void {
  if (peers.length === 0) {
    console.log("No paired peers.");
    return;
  }
  const nameWidth = Math.max(Bun.stringWidth("NAME"), ...peers.map((p) => Bun.stringWidth(p.name)));
  const idWidth = 64;
  console.log(`${pad("NAME", nameWidth)}  ${pad("ID", idWidth)}  PAIRED AT`);
  for (const peer of peers) {
    console.log(`${pad(peer.name, nameWidth)}  ${pad(peer.id, idWidth)}  ${peer.pairedAt}`);
  }
}

async function runRemove(args: string[]): Promise<number> {
  const target = args[0];
  if (target === undefined || target.length === 0) {
    console.error("Usage: ib peer remove <name|id>");
    return 1;
  }
  if (args.length > 1) {
    console.error("Error: ib peer remove takes one name or id. Quote a name that contains spaces.");
    return 1;
  }
  const result = await removePeer(target);
  if (result.ok) {
    console.log(`Removed peer ${JSON.stringify(result.removed.name)} (${result.removed.id}).`);
    return 0;
  }
  if (result.reason === "ambiguous") {
    console.error(`Error: ${result.matches.length} peers are named ${JSON.stringify(target)}. Remove one by its full id:`);
    for (const peer of result.matches) console.error(`  ${peer.id}  (paired ${peer.pairedAt})`);
    return 1;
  }
  console.error(`Error: no paired peer has the name or id ${JSON.stringify(target)}. Run 'ib peer list' to see them.`);
  return 1;
}

/**
 * Run `ib peer <args>` (args exclude "peer" itself). Prints to stdout/stderr
 * and returns the exit code.
 */
export async function runPeerCommand(args: string[]): Promise<number> {
  const sub = args[0];
  try {
    switch (sub) {
      case "id":
        console.log(await loadOrCreatePeerId());
        return 0;
      case "list":
        printPeers(await readPeers());
        return 0;
      case "remove":
        return await runRemove(args.slice(1));
      case "attach":
        return await runAttach(args.slice(1));
      default:
        if (sub !== undefined) console.error(`Error: unknown peer subcommand '${sub}'`);
        console.error(PEER_USAGE);
        return 1;
    }
  } catch (err) {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

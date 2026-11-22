/**
 * The Peers dialog (`I` in `ib watch`; SPEC.md §20.1): this install's id, the
 * paired peers with each one's connection state, a "Pair with id" input, and
 * the pairing stages on either side. The protocol, the endpoint and the
 * poller live in src/peers/ (pairing.ts, service.ts, poller.ts); this module
 * only renders the service's view and maps keys to its calls. Its inputs are
 * the plain dialog input's editing rules, so a pasted id works the same way,
 * bracketed paste included.
 *
 * Esc cancels at every stage, keeps the saved name at the name prompt, leaves
 * a result, and closes the dialog from the idle view.
 */

import { matchesKey, Key, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { describePairFailure } from "../peers/pairing";
import { formatPairCode, isWellFormedPairCode, normalizePairCode } from "../peers/pair-code";
import type { RemoteNewAgentRequest } from "../peers/peer-link";
import type { PeerLinkState } from "../peers/poller";
import type { EndpointStatus, PeerServiceView } from "../peers/service";
import { peerNameProblem, shortPeerId } from "../peers/store";
import { cancelPaste, resolvePasteText, sanitizePasteForSingleLine } from "./clipboard";
import { BOLD, DIM, GREEN, RED, RESET, YELLOW } from "./colors";
import type { DialogCtx } from "./dialog-handler";
import { deleteWord } from "./text-buffer";
import { wordWrapSingleLine, wrapSingleLine } from "./wrap";

/** What the dialog needs from the endpoint service (src/peers/service.ts PeerService). */
export interface PeersDialogService {
  view(): PeerServiceView;
  startRemoteAgent(peerId: string, request: RemoteNewAgentRequest): Promise<string>;
  openDialog(): void;
  closeDialog(): void;
  /** Start pairing with the typed id; returns the inline error, or null once started. */
  pairWith(input: string): string | null;
  submitCode(code: string): void;
  submitName(name: string | null): void;
  cancel(): void;
  dismiss(): void;
  onChange(listener: () => void): () => void;
}

export type PeersDialogState = {
  type: "peers";
  service: PeersDialogService;
  /** The "Pair with id" input. */
  idValue: string;
  /** The current session's input: the code (initiator) or the name. */
  sessionValue: string;
  /**
   * The session and stage `sessionValue` belongs to (`<id>:<stage>`); a new
   * session or stage starts it empty, so the name prompt never inherits the code.
   */
  inputKey: string | null;
  /** Shown in red under the active input. */
  error: string | null;
  /** This machine's name (src/machine-name.ts): the name prompt refuses it. */
  machineName: string;
  width?: number;
};

/** Most peers listed; the rest are counted. */
const MAX_LISTED_PEERS = 10;

export function newPeersDialog(service: PeersDialogService, machineName: string): PeersDialogState {
  return { type: "peers", service, idValue: "", sessionValue: "", inputKey: null, error: null, machineName };
}

/** Start each session stage's input empty. Called on every service change and before every key. */
export function syncPeersDialog(d: PeersDialogState): void {
  const session = d.service.view().session;
  const key = session === null ? null : `${session.id}:${session.stage.stage}`;
  if (key !== d.inputKey) {
    d.inputKey = key;
    d.sessionValue = "";
    d.error = null;
  }
}

/** Single-line editing, the same rules as the plain input dialog. Returns whether `data` edited the field. */
function editLine(ctx: DialogCtx, d: PeersDialogState, field: "idValue" | "sessionValue", data: string): boolean {
  if (matchesKey(data, Key.alt("backspace"))) {
    d[field] = deleteWord(d[field]);
    return true;
  }
  if (matchesKey(data, Key.backspace) || data === "\x7f") {
    d[field] = d[field].slice(0, -1);
    return true;
  }
  const apply = (text: string) => {
    d[field] += sanitizePasteForSingleLine(text);
    d.error = null;
    ctx.tui?.requestRender();
  };
  const pasted = resolvePasteText(data, apply);
  if (pasted !== null) {
    d[field] += sanitizePasteForSingleLine(pasted);
    return true;
  }
  if (data.length === 1 && data >= " ") {
    d[field] += data;
    return true;
  }
  return false;
}

/** Keys while the Peers dialog is open. Consumes every key. */
export function handlePeersDialogInput(ctx: DialogCtx, d: PeersDialogState, data: string): boolean {
  syncPeersDialog(d);
  const session = d.service.view().session;
  const escape = matchesKey(data, Key.escape);
  const enter = matchesKey(data, Key.enter);
  if (escape || enter) cancelPaste();

  if (session === null) {
    if (escape) {
      ctx.closeDialog();
      return true;
    }
    if (enter) {
      d.error = d.service.pairWith(d.idValue);
      if (d.error === null) d.idValue = "";
      syncPeersDialog(d);
    } else if (editLine(ctx, d, "idValue", data)) {
      d.error = null;
    }
    ctx.tui?.requestRender();
    return true;
  }

  switch (session.stage.stage) {
    case "code-entry":
      if (escape) {
        d.service.cancel();
      } else if (enter) {
        const code = normalizePairCode(d.sessionValue);
        if (isWellFormedPairCode(code)) {
          d.error = null;
          d.service.submitCode(code);
        } else {
          d.error = "A code is 8 characters, like ABCD-1234.";
        }
      } else if (editLine(ctx, d, "sessionValue", data)) {
        d.error = null;
      }
      break;
    case "naming":
      if (escape) {
        d.service.submitName(null);
      } else if (enter) {
        // A blank name keeps the saved one, like Esc. Any other is refused
        // inline when another peer or this machine has it (SPEC §20.2).
        d.error = d.sessionValue.trim() === ""
          ? null
          : peerNameProblem(d.sessionValue, session.peerId, d.service.view().peers, d.machineName);
        if (d.error === null) d.service.submitName(d.sessionValue);
      } else if (editLine(ctx, d, "sessionValue", data)) {
        d.error = null;
      }
      break;
    case "done":
    case "failed":
      d.service.dismiss();
      break;
    default:
      // connecting, verifying, incoming, code-shown: only Esc does anything.
      if (escape) d.service.cancel();
  }
  ctx.tui?.requestRender();
  return true;
}

/** The endpoint status: one line, plus the last error on its own line(s) while a retry is pending. */
function statusLines(status: EndpointStatus, now: number): Array<{ text: string; color?: string }> {
  switch (status.kind) {
    case "idle":
    case "starting":
      return [{ text: `${YELLOW}●${RESET} starting…` }];
    case "listening":
      return [{ text: `${GREEN}●${RESET} accepting pairing requests while this dialog is open` }];
    case "disabled":
      return [{ text: `${YELLOW}●${RESET} peering disabled: ib watch pid ${status.ownerPid} owns the endpoint` }];
    case "error":
      if (status.retryAt === null) return [{ text: `${RED}●${RESET} peering unavailable: ${status.message}` }];
      return [
        { text: `${YELLOW}●${RESET} peering unavailable; retrying in ${retrySeconds(status.retryAt, now)} s` },
        { text: `last error: ${status.message}`, color: RED },
      ];
  }
}

/** Whole seconds until `retryAt`, rounded up, at least 1 (the retry is still pending). */
function retrySeconds(retryAt: number, now: number): number {
  return Math.max(1, Math.ceil((retryAt - now) / 1000));
}

/** A duration as its largest whole unit: `42s`, `5m`, `3h`, `2d`. */
export function formatSince(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/**
 * A peer's connection state as plain text: `connected`, `last seen N ago`, or
 * `not connected yet`. The dialog and the remote agent info panel both show it.
 */
export function peerLinkStateText(link: Pick<PeerLinkState, "connected" | "lastOkAt">, now: number): string {
  if (link.connected) return "connected";
  if (link.lastOkAt !== null) return `last seen ${formatSince(now - link.lastOkAt)} ago`;
  return "not connected yet";
}

/** A peer's connection state, after its name and short id. */
function linkStateText(link: PeerLinkState, now: number): string {
  const text = peerLinkStateText(link, now);
  return link.connected ? `${GREEN}● ${text}${RESET}` : `${YELLOW}●${RESET} ${text}`;
}

/** The input line: the end of the value stays visible. */
function inputLine(value: string, innerWidth: number): string {
  const line = `> ${value}█`;
  if (visibleWidth(line) <= innerWidth) return line;
  const tail = Array.from(line);
  while (tail.length > 0 && visibleWidth(`…${tail.join("")}`) > innerWidth) tail.shift();
  return `…${tail.join("")}`;
}

export function buildPeersDialogContent(d: PeersDialogState, innerWidth: number): { title: string; contentLines: string[] } {
  const view = d.service.view();
  const lines: string[] = [];
  const prose = (text: string, color = "") => {
    for (const line of wordWrapSingleLine(text, innerWidth)) lines.push(color ? `${color}${line}${RESET}` : line);
  };
  const error = () => {
    if (d.error !== null) prose(d.error, RED);
  };

  lines.push(`${BOLD}This install's id${RESET}`);
  if (view.selfId !== null) {
    for (const part of wrapSingleLine(view.selfId, innerWidth)) lines.push(part);
  } else if (view.identityError !== null) {
    prose(`unavailable: ${view.identityError}`, RED);
  } else {
    lines.push(`${DIM}loading…${RESET}`);
  }
  for (const line of statusLines(view.status, Date.now())) prose(line.text, line.color);
  lines.push("");

  lines.push(`${BOLD}Paired peers${RESET}`);
  if (view.peersError !== null) {
    prose(view.peersError, RED);
  } else if (view.peers.length === 0) {
    lines.push(`${DIM}  none yet${RESET}`);
  } else {
    const listed = view.peers.slice(0, MAX_LISTED_PEERS);
    const nameWidth = Math.max(...listed.map((p) => visibleWidth(p.name)));
    // The poller's state, once the endpoint has bound; until then, none.
    const links = new Map(view.links.map((link) => [link.id, link]));
    const now = Date.now();
    for (const peer of listed) {
      const pad = " ".repeat(Math.max(0, nameWidth - visibleWidth(peer.name)));
      const link = links.get(peer.id);
      const state = link === undefined ? "" : `  ${linkStateText(link, now)}`;
      lines.push(truncateToWidth(`  ${peer.name}${pad}  ${DIM}${shortPeerId(peer.id)}${RESET}${state}`, innerWidth, ""));
      if (link !== undefined && !link.connected && link.lastError !== null) {
        for (const line of wordWrapSingleLine(link.lastError, Math.max(1, innerWidth - 4))) lines.push(`    ${RED}${line}${RESET}`);
      }
    }
    if (view.peers.length > listed.length) {
      lines.push(`${DIM}  …and ${view.peers.length - listed.length} more (ib peer list shows all)${RESET}`);
    }
  }
  lines.push("");

  let hint: string;
  const session = view.session;
  if (session === null) {
    lines.push(`${BOLD}Pair with id${RESET}`);
    lines.push(inputLine(d.idValue, innerWidth));
    error();
    hint = "Enter: pair    Esc: close";
  } else {
    const peer = shortPeerId(session.peerId);
    const stage = session.stage;
    switch (stage.stage) {
      case "connecting":
        prose(`Connecting to ${peer}…`);
        hint = "Esc: cancel";
        break;
      case "code-entry": {
        prose(`${peer} is showing a pairing code. Type it here.`);
        const self = view.selfId !== null ? shortPeerId(view.selfId) : "?";
        lines.push(`${BOLD}Code${RESET}  ${DIM}(your id: ${self})${RESET}`);
        lines.push(inputLine(d.sessionValue, innerWidth));
        error();
        hint = "Enter: send code    Esc: cancel";
        break;
      }
      case "verifying":
        prose(`Checking the code with ${peer}…`);
        hint = "Esc: cancel";
        break;
      case "incoming":
        prose(`Pairing request from ${peer}…`);
        hint = "Esc: cancel";
        break;
      case "code-shown":
        prose(`Pairing request from ${peer}. Code: ${BOLD}${formatPairCode(stage.code)}${RESET}. Expires in 2 min.`);
        hint = "Esc: cancel";
        break;
      case "naming":
        prose(`Paired with ${peer}.`, GREEN);
        lines.push(`${BOLD}Name for ${peer}:${RESET}`);
        lines.push(inputLine(d.sessionValue, innerWidth));
        error();
        hint = `Enter: save    Esc: keep ${JSON.stringify(stage.savedName)}`;
        break;
      case "done":
        prose(
          stage.alreadyPaired
            ? `${peer} was already paired, as ${JSON.stringify(stage.name)}.`
            : `Paired with ${JSON.stringify(stage.name)} (${peer}).`,
          GREEN,
        );
        hint = "Press any key to continue";
        break;
      case "failed":
        prose(describePairFailure(stage.failure, peer), RED);
        hint = "Press any key to continue";
        break;
    }
  }
  lines.push("");
  prose(hint, DIM);
  return { title: "Peers", contentLines: lines };
}

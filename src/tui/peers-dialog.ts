/**
 * The Peers tab of setup (`h`, or `I` to open it directly; SPEC.md §20.1): this install's id, the
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

import { matchesKey, Key, visibleWidth } from "@mariozechner/pi-tui";
import { describePairFailure } from "../peers/pairing";
import { formatPairCode, isWellFormedPairCode, normalizePairCode } from "../peers/pair-code";
import type { RemoteNewAgentRequest } from "../peers/peer-link";
import { peerLinkStatus, type PeerLinkStatus } from "../peers/poller";
import type { EndpointStatus, PeerServiceView } from "../peers/service";
import { peerNameProblem, shortPeerId, SHORT_ID_LENGTH } from "../peers/store";
import { cancelPaste, isPasteInProgress, resolvePasteText, sanitizePasteForSingleLine } from "./clipboard";
import { BOLD, DIM, GREEN, RED, RESET, YELLOW } from "./colors";
import type { DialogCtx } from "./dialog-handler";
import { truncatePeerField } from "./peer-repos";
import { deleteWord } from "./text-buffer";
import { wordWrapSingleLine, wrapSingleLine } from "./wrap";

/** What the dialog needs from the endpoint service (src/peers/service.ts PeerService). */
export interface PeersDialogService {
  readonly remoteStartDenial: string | null;
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
};

/** Most peers listed; the rest are counted. */
const MAX_LISTED_PEERS = 10;

export function newPeersDialog(service: PeersDialogService, machineName: string): PeersDialogState {
  return { service, idValue: "", sessionValue: "", inputKey: null, error: null, machineName };
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
  if (!isPasteInProgress() && data.length === 1 && data >= " ") {
    d[field] += data;
    return true;
  }
  return false;
}

/** Handle a key in the Peers tab after setup navigation. */
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
      if (enter || escape) d.service.dismiss();
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
      return [{ text: `${GREEN}●${RESET} accepting pairing requests while this tab is visible` }];
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

const linkColors: Record<PeerLinkStatus, string> = { connected: GREEN, connecting: YELLOW, offline: RED };

/** The same colored word appears in the Peers tab and the remote agent's Machine line. */
export function peerLinkStateText(status: PeerLinkStatus): string {
  return `${linkColors[status]}${status}${RESET}`;
}

/** The input line: the end of the value stays visible. */
function inputLine(value: string, innerWidth: number): string {
  const line = `> ${value}█`;
  if (visibleWidth(line) <= innerWidth) return line;
  const tail = Array.from(line);
  while (tail.length > 0 && visibleWidth(`…${tail.join("")}`) > innerWidth) tail.shift();
  return `…${tail.join("")}`;
}

function proseLines(text: string, width: number, color = ""): string[] {
  return wordWrapSingleLine(text, width).map(line => color ? `${color}${line}${RESET}` : line);
}

function peerListLines(view: PeerServiceView, innerWidth: number, available: number, maxLines: number): string[] {
  if (view.peersError !== null) return proseLines(view.peersError, innerWidth, RED).slice(0, available);
  if (view.peers.length === 0) return [`${DIM}  none yet${RESET}`].slice(0, available);
  const listed = view.peers.slice(0, MAX_LISTED_PEERS);
  // Reserve the indent, both gaps, the short id and the longest status word.
  const availableNameWidth = innerWidth - 6 - SHORT_ID_LENGTH - "connecting".length;
  const nameWidth = Math.min(availableNameWidth, Math.max(...listed.map(p => visibleWidth(p.name))));
  const links = new Map(view.links.map((link) => [link.id, link]));
  const groups = listed.map(peer => {
    const lines: string[] = [];
    const link = links.get(peer.id);
    const state = peerLinkStateText(peerLinkStatus(link));
    const id = `${DIM}${shortPeerId(peer.id)}${RESET}`;
    if (nameWidth > 0) {
      const name = truncatePeerField(peer.name, nameWidth);
      const pad = " ".repeat(nameWidth - visibleWidth(name));
      lines.push(`  ${name}${pad}  ${id}  ${state}`);
    } else {
      lines.push(truncatePeerField(peer.name, innerWidth), ...wordWrapSingleLine(`${id}  ${state}`, innerWidth));
    }
    const error = link && !link.connected && link.lastError !== null
      ? wordWrapSingleLine(link.lastError, Math.max(1, innerWidth - 4)).map(line => `    ${RED}${line}${RESET}`)
      : [];
    return { lines, error };
  });

  // Reclaim header space if needed for the first peer, its first error line and the count.
  const first = groups[0]!;
  const firstMinimum = first.lines.length + Math.min(1, first.error.length);
  const budget = Math.min(maxLines, Math.max(available, firstMinimum + (view.peers.length > 1 ? 1 : 0)));
  const overflow = (hidden: number) => {
    if (hidden === 0) return [];
    const count = `…and ${hidden} more`;
    const full = proseLines(`  ${count} (ib peer list shows all)`, innerWidth, DIM);
    return first.lines.length + first.error.length + full.length <= budget ? full : [`${DIM}  ${count}${RESET}`];
  };
  const result: string[] = [];
  let shown = 0;
  for (const group of groups) {
    const room = budget - result.length - overflow(view.peers.length - shown - 1).length;
    if (group.lines.length + Math.min(1, group.error.length) > room) break;
    result.push(...group.lines, ...group.error.slice(0, room - group.lines.length));
    shown++;
  }
  return [...result, ...overflow(view.peers.length - shown)].slice(0, budget);
}

export function buildPeersDialogContent(d: PeersDialogState, innerWidth: number, maxLines: number): string[] {
  const view = d.service.view();
  const header = [`${BOLD}This install's id${RESET}`];
  if (view.selfId !== null) {
    header.push(...wrapSingleLine(view.selfId, innerWidth));
  } else if (view.identityError !== null) {
    header.push(...proseLines(`unavailable: ${view.identityError}`, innerWidth, RED));
  } else {
    header.push(`${DIM}loading…${RESET}`);
  }
  for (const line of statusLines(view.status, Date.now())) header.push(...proseLines(line.text, innerWidth, line.color));
  header.push("");

  const pairing = buildPairingContent(d, view, innerWidth);
  // Leave the active input, error and key hint together at the bottom of the overlay.
  const room = Math.max(0, maxLines - pairing.length - 2); // Paired peers heading and separator
  const peers = peerListLines(view, innerWidth, Math.max(1, room - header.length), room);
  const top = header.slice(0, Math.max(0, room - peers.length));
  return [...top, `${BOLD}Paired peers${RESET}`, ...peers, "", ...pairing];
}

function buildPairingContent(d: PeersDialogState, view: PeerServiceView, innerWidth: number): string[] {
  const lines: string[] = [];
  const prose = (text: string, color = "") => lines.push(...proseLines(text, innerWidth, color));
  const error = () => {
    if (d.error !== null) prose(d.error, RED);
  };
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
        hint = "Enter or Esc: return to Peers";
        break;
      case "failed":
        prose(describePairFailure(stage.failure, peer), RED);
        hint = "Enter or Esc: return to Peers";
        break;
    }
  }
  lines.push("");
  prose(hint, DIM);
  return lines;
}

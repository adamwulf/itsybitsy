import { spellPath } from "../message-attachments";

export interface AttachmentMapping {
  spellings: readonly string[];
  destination: string;
}

interface Match { length: number; replacement: string }
interface State { next: Map<number, number>; fallback: number; match?: Match }
const boundary = -1;
const whitespace = /\s/;

/** A reverse Aho-Corasick index. Mark each right word boundary explicitly
 * so a suffix match always ends at whitespace or the text edge. Scanning
 * backwards finds the longest complete match at each eligible start. */
function indexMappings(mapping: readonly AttachmentMapping[]) {
  const states: State[] = [{ next: new Map(), fallback: 0 }];
  function insert(form: string, replacement: string) {
    let state = 0;
    function add(symbol: number) {
      let next = states[state]!.next.get(symbol);
      if (next === undefined) {
        next = states.length;
        states[state]!.next.set(symbol, next);
        states.push({ next: new Map(), fallback: 0 });
      }
      state = next;
    }
    add(boundary);
    for (let i = form.length - 1; i >= 0; i--) {
      add(form.charCodeAt(i));
      if (i && whitespace.test(form[i]!)) add(boundary);
    }
    states[state]!.match ??= { length: form.length, replacement };
  }
  for (const { spellings, destination } of mapping) {
    for (const spelling of new Set(spellings)) {
      if (!spelling) continue;
      insert(spelling, spellPath(destination));
      for (const quote of [undefined, "'", '"']) insert(spellPath(spelling, quote), spellPath(destination, quote));
    }
  }
  function advance(state: number, symbol: number) {
    while (state && !states[state]!.next.has(symbol)) state = states[state]!.fallback;
    return states[state]!.next.get(symbol) ?? 0;
  }
  const queue = [...states[0]!.next.values()];
  for (let i = 0; i < queue.length; i++) {
    const state = states[queue[i]!]!;
    for (const [symbol, next] of state.next) {
      const child = states[next]!;
      child.fallback = advance(state.fallback, symbol);
      child.match ??= states[child.fallback]!.match;
      queue.push(next);
    }
  }
  return { states, advance };
}

export function rewriteAttachmentPaths(message: string, mapping: readonly AttachmentMapping[], maxBytes = Infinity): string {
  if (!mapping.length) return message;
  const { states, advance } = indexMappings(mapping);
  const matches = new Map<number, Match>();
  let state = 0;
  for (let i = message.length - 1; i >= 0; i--) {
    if (i === message.length - 1 || whitespace.test(message[i + 1]!)) state = advance(state, boundary);
    state = advance(state, message.charCodeAt(i));
    const match = states[state]!.match;
    if (match && (!i || whitespace.test(message[i - 1]!))) matches.set(i, match);
  }
  const parts: string[] = [];
  let bytes = 0;
  function append(part: string) {
    bytes += Buffer.byteLength(part);
    if (bytes > maxBytes) throw new Error(`Rewritten message exceeds ${maxBytes} bytes`);
    parts.push(part);
  }
  let cursor = 0;
  for (let i = 0; i < message.length; i++) {
    const match = matches.get(i);
    if (!match) continue;
    append(message.slice(cursor, i));
    append(match.replacement);
    cursor = i + match.length;
    i = cursor - 1;
  }
  append(message.slice(cursor));
  append("\n\nAttachments copied to this machine:");
  for (const file of mapping) append(`\n- ${file.spellings[0]} → ${spellPath(file.destination)}`);
  return parts.join("");
}

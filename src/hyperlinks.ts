/**
 * OSC 8 terminal hyperlinks for agent output that `ib watch` re-renders.
 *
 * Ghostty finds links in plain text with a fixed scheme list that has no
 * `message:` (src/config/url.zig), so a bare Apple Mail URL is only clickable if
 * we emit it as a real hyperlink. Everything here uses the BEL-terminated form,
 * the same one closeOsc8 and pi-tui's per-line reset use.
 */

export const OSC8_OPEN = "\x1b]8;;";
export const OSC8_CLOSE = "\x1b]8;;\x07";

/**
 * Ensure any unclosed OSC 8 hyperlink is terminated after truncation.
 * Also strips partial OSC sequences left by mid-sequence truncation
 * (e.g. truncation cut between \x1b]8;; and the \x07 terminator).
 */
export function closeOsc8(line: string): string {
  if (!line.includes(OSC8_OPEN)) return line;
  const lastOpen = line.lastIndexOf(OSC8_OPEN);
  const lastClose = line.indexOf(OSC8_CLOSE, lastOpen);
  if (lastClose !== -1) return line;
  // Check for partial OSC: open tag found but no BEL terminator after it
  // means truncation cut inside the URI portion — strip the partial sequence
  const belAfterOpen = line.indexOf("\x07", lastOpen);
  if (belAfterOpen === -1) {
    // Truncated mid-OSC — remove the partial sequence and close cleanly
    return line.slice(0, lastOpen) + OSC8_CLOSE;
  }
  // BEL present means the open sequence completed (we're in display text) — just close it
  return line + OSC8_CLOSE;
}

/**
 * What `capture-pane -e` adds to plain text: OSC 8 hyperlinks (group 1 is the
 * target, any params such as tmux's id= are dropped), CSI styling including colon
 * forms like 4:3m, and the SO/SI shifts around line-drawing cells. The other two
 * alternatives, other OSC strings and other two-character escapes, are a safety
 * net: tmux doesn't write them, and nothing else should reach the terminal.
 */
const CAPTURE_ESCAPES =
  /\x1b\]8;[^;\x07\x1b]*;([^\x07\x1b]*)(?:\x07|\x1b\\)|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b\[[0-?]*[ -/]*[@-~]|\x1b[ -/]*[0-~]|[\x0e\x0f]/g;

/**
 * Link targets kept from a pane. A Markdown link shows only its label, so the
 * person clicking can't see where it goes. A sandboxed agent must not be able to
 * put a local file or an app's URL scheme behind friendly text and have the click
 * run outside its sandbox.
 */
const ALLOWED_LINK_TARGET = /^(?:message:|https?:)[\x21-\x7e]+$/i;

/**
 * Reduce a `capture-pane -e` capture to its plain text plus hyperlinks with an
 * allowed target, in BEL-form OSC 8 and closed by the end of each line. Styling is
 * dropped, so panes keep rendering as uncolored text; the capture only needs -e
 * because that's the one way to read a link's target out of tmux.
 */
export function keepAllowedLinks(capture: string): string {
  return capture.split("\n").map((line) => {
    let open: string | null = null;
    const body = line.replace(CAPTURE_ESCAPES, (_match, target?: string) => {
      if (target === undefined) return "";
      const next = ALLOWED_LINK_TARGET.test(target) ? target : null;
      if (next === open) return "";
      open = next;
      return next ? `${OSC8_OPEN}${next}\x07` : OSC8_CLOSE;
    });
    // tmux closes links per line; this keeps the row safe to draw beside the
    // right pane if a capture ever doesn't.
    return open ? body + OSC8_CLOSE : body;
  }).join("\n");
}

/**
 * Either a complete existing link on one line (matched so its text is skipped)
 * or a bare message:// URL. The URL part is limited to RFC 3986 characters, minus
 * the quote, so it stops at the wrappers it really appears in: `<url>` in iris
 * output, `'url'` in an `open` command, backticks, and table borders.
 */
const LINK_OR_MESSAGE_URL =
  /\x1b\]8;;[^\x07\x1b]+\x07.*?\x1b\]8;;\x07|(?<![A-Za-z0-9+.-])message:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&()*+,;=%]+/g;

/** Sentence or Markdown punctuation that follows a URL rather than ending it. */
const TRAILING_PUNCTUATION = /[.,;:!?*)\]]+$/;

/** Wrap each bare message:// URL in `text` in an OSC 8 hyperlink to itself. */
export function linkifyMessageUrls(text: string): string {
  if (!text.includes("message://")) return text;
  return text.replace(LINK_OR_MESSAGE_URL, (match) => {
    if (match.startsWith("\x1b")) return match;
    const url = match.replace(TRAILING_PUNCTUATION, "");
    if (url === "message://") return match;
    return `${OSC8_OPEN}${url}\x07${url}${OSC8_CLOSE}${match.slice(url.length)}`;
  });
}

const OSC8_SEQUENCE = /\x1b\]8;;([^\x07\x1b]*)\x07/g;

/**
 * Make each wrapped row a self-contained run of hyperlinks. A link split across
 * rows is closed at the end of each row and reopened at the start of the next,
 * so it stays clickable on every row and can't spill into the column drawn to
 * the right of the pane.
 */
export function balanceLinkRows(rows: string[]): string[] {
  let open: string | null = null;
  return rows.map((row) => {
    const prefix = open ? `${OSC8_OPEN}${open}\x07` : "";
    for (const match of row.matchAll(OSC8_SEQUENCE)) {
      open = match[1] || null;
    }
    return prefix + row + (open ? OSC8_CLOSE : "");
  });
}

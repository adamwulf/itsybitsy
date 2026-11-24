import { truncateToWidth } from "@mariozechner/pi-tui";
import { closeOsc8 } from "../hyperlinks";
import { clampPaneLines, cleanRemoteText, type PeerPane, type PeerPaneTarget } from "../peers/peer-link";
import { DIM, RED, RESET } from "./colors";
import { computeChromeSlice, padLines, WordWrapCache, wordWrapSingleLine, type ChromeSlice } from "./wrap";

type Selection = { peerId: string; target: PeerPaneTarget };

/** Only the selected peer is polled. In-flight reads survive deselection until
 * the service settles them, so returning to a peer cannot start a second read.
 * A coordinator's own input box is sliced off the capture, as for a local
 * coordinator: render() draws the transcript above it, and statusLines() the
 * CLI's status lines, which the dashboard draws below its own input field. */
export class RemotePane {
  private selectedKey: string | null = null;
  private active: Selection | null = null;
  private trimChrome = false;
  private visible = true;
  private denial: string | null = null;
  private cancel: (() => void) | null = null;
  private inFlight = new Set<string>();
  private scrollBack = 0;
  displayHeight = 0;
  private maxVisibleOffset = 0;
  private text: string | null = null;
  private error: string | null = null;
  private wrap = new WordWrapCache();
  private sliced: { text: string; slice: ChromeSlice } | null = null;

  constructor(
    private fetch: (peerId: string, target: PeerPaneTarget, lines: number) => Promise<PeerPane>,
    private redraw: () => void,
    private every = (ms: number, tick: () => void) => {
      const timer = setInterval(tick, ms);
      return () => clearInterval(timer);
    },
  ) {}

  select(selection: Selection | null, denial: string | null = null, visible = true): void {
    const key = selection && JSON.stringify([selection.peerId, selection.target]);
    const sameSelection = key === this.selectedKey && denial === this.denial;
    if (sameSelection && visible === this.visible) return;
    this.cancel?.();
    this.cancel = null;
    this.selectedKey = key;
    this.active = null;
    this.trimChrome = selection?.target.op === "coordinator-pane";
    this.denial = denial;
    this.visible = visible;
    if (!sameSelection) {
      this.text = null;
      this.error = null;
      this.wrap.reset();
      this.scrollBack = 0;
      this.maxVisibleOffset = 0;
    }
    if (!visible || selection === null || denial !== null) return;
    // A resumed view gets a fresh identity even when the caller reuses its target.
    const active = { ...selection };
    this.active = active;
    const tick = () => this.poll(active);
    this.cancel = this.every(2_000, tick);
    void tick();
  }

  private async poll(selection: Selection): Promise<void> {
    const { peerId: id, target } = selection;
    if (this.active !== selection || this.inFlight.has(id)) return;
    this.inFlight.add(id);
    try {
      const lines = clampPaneLines(this.displayHeight + this.scrollBack + 10);
      const { text } = await this.fetch(id, target, lines);
      if (selection !== this.active) return;
      if (this.text === text && this.error === null) return;
      this.text = text;
      this.error = null;
    } catch (err) {
      const message = cleanRemoteText(err instanceof Error ? err.message : String(err)) || "Pane read failed";
      if (selection !== this.active || message === this.error) return;
      this.error = message;
    } finally {
      this.inFlight.delete(id);
      // Selection may have changed to another pane on this peer while it held the slot.
      if (this.active?.peerId === id && this.active !== selection) void this.poll(this.active);
    }
    this.redraw();
  }

  scroll(lines: number): void {
    // Scrolling up may ask beyond this capture. Scroll down from the top
    // actually displayed even if the peer has less history than requested.
    const from = lines < 0 ? Math.min(this.scrollBack, this.maxVisibleOffset) : this.scrollBack;
    this.scrollBack = Math.max(0, from + lines);
    this.redraw();
  }

  /** The capture split at a coordinator's input box (the Claude detector, as for a local coordinator); an agent's capture whole. */
  private slice(): ChromeSlice | null {
    if (this.text === null) return null;
    if (!this.trimChrome) return { transcriptRaw: this.text, statusLines: [] };
    if (this.sliced?.text !== this.text) this.sliced = { text: this.text, slice: computeChromeSlice(this.text, false) };
    return this.sliced.slice;
  }

  /** The CLI's status lines from below its input box, each truncated to `width`, never wrapped. */
  statusLines(width: number): string[] {
    if (this.denial !== null) return [];
    return (this.slice()?.statusLines ?? []).map((line) => closeOsc8(truncateToWidth(line, width, "")));
  }

  render(width: number, height: number): string[] {
    this.displayHeight = height;
    if (height <= 0) return [];
    if (this.denial !== null) return padLines(wordWrapSingleLine(this.denial, width), height);
    const slice = this.slice();
    const output = slice !== null ? this.wrap.get(slice.transcriptRaw, width)
      : this.error === null ? [`${DIM}Waiting for output…${RESET}`] : [];
    const room = height - (this.error === null ? 0 : 1);
    this.maxVisibleOffset = Math.max(0, output.length - room);
    const end = output.length - Math.min(this.scrollBack, this.maxVisibleOffset);
    const lines = padLines(output.slice(Math.max(0, end - room), end), room);
    if (this.error !== null) lines.push(truncateToWidth(`${RED}${this.error}${RESET}`, width, "…"));
    return lines;
  }
}

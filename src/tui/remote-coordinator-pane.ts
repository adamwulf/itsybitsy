import { truncateToWidth } from "@mariozechner/pi-tui";
import { cleanRemoteText, type CoordinatorPane } from "../peers/peer-link";
import { DIM, RED, RESET } from "./colors";
import { padLines, WordWrapCache, wordWrapSingleLine } from "./wrap";

/** Only the selected peer is polled. In-flight reads survive deselection until
 * the service settles them, so returning to a peer cannot start a second read. */
export class RemoteCoordinatorPane {
  private selected: string | null = null;
  private visible = true;
  private denial: string | null = null;
  private cancel: (() => void) | null = null;
  private inFlight = new Set<string>();
  private scrollBack = 0;
  private text: string | null = null;
  private error: string | null = null;
  private wrap = new WordWrapCache();

  constructor(
    private fetch: (id: string) => Promise<CoordinatorPane>,
    private redraw: () => void,
    private every = (ms: number, tick: () => void) => {
      const timer = setInterval(tick, ms);
      return () => clearInterval(timer);
    },
  ) {}

  select(id: string | null, denial: string | null = null, visible = true): void {
    const samePeer = id === this.selected && denial === this.denial;
    if (samePeer && visible === this.visible) return;
    this.cancel?.();
    this.cancel = null;
    this.selected = id;
    this.denial = denial;
    this.visible = visible;
    if (!samePeer) {
      this.text = null;
      this.error = null;
      this.wrap.reset();
      this.scrollBack = 0;
    }
    if (!visible || id === null || denial !== null) return;
    const tick = () => this.poll(id);
    this.cancel = this.every(2_000, tick);
    void tick();
  }

  private async poll(id: string): Promise<void> {
    if (this.inFlight.has(id)) return;
    const selection = this.cancel;
    this.inFlight.add(id);
    try {
      const { text } = await this.fetch(id);
      if (selection !== this.cancel || (this.text === text && this.error === null)) return;
      this.text = text;
      this.error = null;
    } catch (err) {
      const message = cleanRemoteText(err instanceof Error ? err.message : String(err)) || "Pane read failed";
      if (selection !== this.cancel || message === this.error) return;
      this.error = message;
    } finally {
      this.inFlight.delete(id);
    }
    this.redraw();
  }

  scroll(lines: number): void {
    this.scrollBack = Math.max(0, this.scrollBack + lines);
    this.redraw();
  }

  render(width: number, height: number): string[] {
    if (this.denial !== null) return padLines(wordWrapSingleLine(this.denial, width), height);
    const output = this.text !== null ? this.wrap.get(this.text, width)
      : this.error === null ? [`${DIM}Waiting for output…${RESET}`] : [];
    const room = height - (this.error === null ? 0 : 1);
    this.scrollBack = Math.min(this.scrollBack, Math.max(0, output.length - room));
    const end = output.length - this.scrollBack;
    const lines = padLines(output.slice(Math.max(0, end - room), end), room);
    if (this.error !== null) lines.push(truncateToWidth(`${RED}${this.error}${RESET}`, width, "…"));
    return lines;
  }
}

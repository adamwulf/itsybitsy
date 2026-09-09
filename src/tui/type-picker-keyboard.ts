import { isKeyRelease, type Terminal } from "@mariozechner/pi-tui";

/** Request text-key modifiers only while the Type picker needs them.
 * pi-tui enables Kitty flags 1|2|4, which still send Shift+Space as text.
 * Add flags 8|16 to its existing stack entry; ProcessTerminal.stop() restores
 * the original terminal mode by popping that entry, even if Type has focus.
 */
export class TypePickerKeyboard {
  private reporting = false;

  constructor(
    private terminal: Pick<Terminal, "write" | "kittyProtocolActive">,
    private isTypeFocused: () => boolean,
  ) {}

  handleInput(data: string, dispatch: (data: string) => void): void {
    // pi-tui 0.56 does not parse Kitty's associated-text parameter. Strip it
    // for shortcut matching, but retain the text for keys already in flight
    // when Tab/Escape leaves the picker and restores normal reporting.
    const associated = data.match(/^(\x1b\[\d+(?::\d*){0,2});(\d*)(:\d+)?;([\d:]+)u$/);
    const key = associated ? `${associated[1]};${associated[2] || "1"}${associated[3] || ""}u` : data;
    if (!isKeyRelease(key)) {
      let input = key;
      if (associated && !this.isTypeFocused()) {
        const points = associated[4]!.split(":").map(Number);
        if (points.every(cp => cp >= 32 && cp <= 0x10ffff &&
          !(cp >= 0x7f && cp <= 0x9f) && !(cp >= 0xd800 && cp <= 0xdfff))) {
          input = points.map(cp => String.fromCodePoint(cp)).join("");
        }
      }
      dispatch(input);
    }
    this.sync();
  }

  private sync(): void {
    const reporting = this.terminal.kittyProtocolActive && this.isTypeFocused();
    if (reporting === this.reporting) return;
    // Set/reset only these bits, retaining pi-tui's negotiated flags.
    this.terminal.write(reporting ? "\x1b[=24;2u" : "\x1b[=24;3u");
    this.reporting = reporting;
  }
}

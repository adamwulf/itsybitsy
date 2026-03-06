/**
 * Terminal color scheme detection and live-watching.
 * Detects light/dark via OSC 11 background color query,
 * and subscribes to Ghostty's mode 2031 notifications.
 */

export type ColorScheme = "light" | "dark";

/**
 * Parse an OSC 11 response to extract RGB values (normalized 0-1).
 * Handles both 4-digit (rgb:RRRR/GGGG/BBBB) and 2-digit (rgb:RR/GG/BB) hex per channel.
 * Returns null if the input doesn't match.
 */
export function parseOSC11Response(data: string): { r: number; g: number; b: number } | null {
  // Match rgb:XX/XX/XX or rgb:XXXX/XXXX/XXXX (or mixed lengths)
  const match = data.match(/rgb:([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)/);
  if (!match) return null;

  const rHex = match[1]!;
  const gHex = match[2]!;
  const bHex = match[3]!;

  function normalize(hex: string): number {
    const val = parseInt(hex, 16);
    // 4-digit hex: max is 0xFFFF; 2-digit: max is 0xFF
    const max = hex.length <= 2 ? 0xff : 0xffff;
    return val / max;
  }

  return {
    r: normalize(rHex),
    g: normalize(gHex),
    b: normalize(bHex),
  };
}

/**
 * Compute relative luminance from linear RGB values (each 0-1).
 * Uses the ITU-R BT.709 coefficients.
 */
export function computeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Map a luminance value to a color scheme.
 */
export function luminanceToScheme(luminance: number): ColorScheme {
  return luminance < 0.5 ? "dark" : "light";
}

/**
 * Query the terminal's background color via OSC 11 and return the detected scheme.
 * Times out after 100ms and defaults to 'dark'.
 * Must be called when stdin is in raw mode (the dashboard already does this).
 */
export async function detectColorScheme(): Promise<ColorScheme> {
  return new Promise<ColorScheme>((resolve) => {
    let resolved = false;
    let buffer = "";

    const timer = setTimeout(() => {
      if (!resolved) {
        resolved = true;
        process.stdin.removeListener("data", onData);
        resolve("dark");
      }
    }, 100);

    function onData(chunk: Buffer) {
      buffer += chunk.toString();
      // Look for the OSC 11 response: ESC ] 11 ; rgb:... BEL or ST
      // BEL = \x07, ST = ESC \ (\x1b\\)
      const match = buffer.match(/\x1b\]11;([^\x07\x1b]*?)(?:\x07|\x1b\\)/);
      if (match) {
        resolved = true;
        clearTimeout(timer);
        process.stdin.removeListener("data", onData);
        const rgb = parseOSC11Response(match[1]!);
        if (rgb) {
          const lum = computeLuminance(rgb.r, rgb.g, rgb.b);
          resolve(luminanceToScheme(lum));
        } else {
          resolve("dark");
        }
      }
    }

    process.stdin.on("data", onData);
    // Send OSC 11 query
    process.stdout.write("\x1b]11;?\x07");
  });
}

// Escape sequences for Ghostty mode 2031 notifications
const GHOSTTY_ENABLE = "\x1b[?2031h";
const GHOSTTY_DISABLE = "\x1b[?2031l";
// Focus reporting
const FOCUS_ENABLE = "\x1b[?1004h";
const FOCUS_DISABLE = "\x1b[?1004l";

// Ghostty dark/light notification patterns
const GHOSTTY_DARK = "\x1b[?2031;1m";
const GHOSTTY_LIGHT = "\x1b[?2031;2m";
// Focus-in event
const FOCUS_IN = "\x1b[I";

/**
 * Input filter for the dashboard's input handler.
 * Returns true if the data was consumed (color-scheme related), false otherwise.
 * This allows the dashboard to call this before its own key handling.
 */
export type InputFilter = (data: string) => boolean;

/**
 * Watch for color scheme changes. On startup, detects the current scheme
 * and calls onChange. Then listens for:
 * - Ghostty mode 2031 notifications (dark/light)
 * - Focus-in events (re-detect via OSC 11)
 *
 * Returns a cleanup object with:
 * - cleanup(): disable notifications and remove listeners
 * - inputFilter: an InputFilter to call from the dashboard's input handler
 */
export function watchColorScheme(
  onChange: (scheme: ColorScheme) => void
): { cleanup: () => void; inputFilter: InputFilter } {
  let currentScheme: ColorScheme | null = null;

  // Initial detection
  detectColorScheme().then((scheme) => {
    currentScheme = scheme;
    onChange(scheme);
  });

  // Enable Ghostty notifications and focus reporting
  process.stdout.write(GHOSTTY_ENABLE);
  process.stdout.write(FOCUS_ENABLE);

  // The input filter intercepts color-scheme escape sequences
  // before they reach normal key handling
  const inputFilter: InputFilter = (data: string): boolean => {
    if (data === GHOSTTY_DARK || data.includes(GHOSTTY_DARK)) {
      if (currentScheme !== "dark") {
        currentScheme = "dark";
        onChange("dark");
      }
      return true;
    }
    if (data === GHOSTTY_LIGHT || data.includes(GHOSTTY_LIGHT)) {
      if (currentScheme !== "light") {
        currentScheme = "light";
        onChange("light");
      }
      return true;
    }
    if (data === FOCUS_IN || data.includes(FOCUS_IN)) {
      // Re-detect on focus-in
      detectColorScheme().then((scheme) => {
        if (scheme !== currentScheme) {
          currentScheme = scheme;
          onChange(scheme);
        }
      });
      // Don't consume — other handlers may want focus events too
      return false;
    }
    // Check for OSC 11 response in normal input stream
    if (data.includes("\x1b]11;")) {
      return true;
    }
    return false;
  };

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    process.stdout.write(GHOSTTY_DISABLE);
    process.stdout.write(FOCUS_DISABLE);
  };

  return { cleanup, inputFilter };
}

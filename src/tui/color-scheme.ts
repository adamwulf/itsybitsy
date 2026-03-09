/**
 * Terminal color scheme detection (OSC 11, Ghostty mode 2031).
 * Exports getStateColors() and setupColorSchemeDetection().
 */

import {
  RED, GREEN, YELLOW, BLUE, MAGENTA, CYAN, WHITE,
  DIM_GRAY, BRIGHT_BLUE, BRIGHT_MAGENTA,
} from "./colors";

type ColorScheme = "dark" | "light";
let colorScheme: ColorScheme = "dark";

export function getStateColors(): Record<string, string> {
  if (colorScheme === "light") {
    return {
      creating: YELLOW, running: GREEN, waiting: CYAN, complete: BLUE,
      compacting: MAGENTA, rate_limited: RED, stopped: DIM_GRAY, unknown: WHITE,
    };
  }
  return {
    creating: YELLOW, running: GREEN, waiting: CYAN, complete: BRIGHT_BLUE,
    compacting: BRIGHT_MAGENTA, rate_limited: RED, stopped: DIM_GRAY, unknown: WHITE,
  };
}

// Ghostty mode 2031 escape sequences
const GHOSTTY_ENABLE = "\x1b[?2031h";
const GHOSTTY_DISABLE = "\x1b[?2031l";
const GHOSTTY_DARK = "\x1b[?2031;1m";
const GHOSTTY_LIGHT = "\x1b[?2031;2m";

/** Parse an OSC 11 response to extract normalized RGB (0-1). */
function parseOSC11Response(data: string): { r: number; g: number; b: number } | null {
  const match = data.match(/rgb:([0-9a-fA-F]+)\/([0-9a-fA-F]+)\/([0-9a-fA-F]+)/);
  if (!match) return null;
  function normalize(hex: string): number {
    const val = parseInt(hex, 16);
    const max = hex.length <= 2 ? 0xff : 0xffff;
    return val / max;
  }
  return { r: normalize(match[1]!), g: normalize(match[2]!), b: normalize(match[3]!) };
}

/** Compute relative luminance (ITU-R BT.709). */
function computeLuminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Set up color scheme detection. Returns:
 * - inputFilter: call before other key handling; returns true if data was consumed
 * - queryColorScheme: send OSC 11 query (call after tui.start() when stdin is raw)
 * - cleanup: disable notifications
 */
export function setupColorSchemeDetection(
  onSchemeChange: () => void
): { inputFilter: (data: string) => boolean; queryColorScheme: () => void; cleanup: () => void } {
  let pendingDetection = false;
  let detectionTimer: ReturnType<typeof setTimeout> | null = null;

  function applyScheme(scheme: ColorScheme): void {
    if (scheme !== colorScheme) {
      colorScheme = scheme;
      onSchemeChange();
    }
  }

  function queryColorScheme(): void {
    pendingDetection = true;
    if (detectionTimer) clearTimeout(detectionTimer);
    detectionTimer = setTimeout(() => {
      if (pendingDetection) {
        pendingDetection = false;
      }
    }, 500);
    process.stdout.write("\x1b]11;?\x07");
  }

  process.stdout.write(GHOSTTY_ENABLE);

  const inputFilter = (data: string): boolean => {
    // OSC 11 response
    if (data.includes("\x1b]11;")) {
      const match = data.match(/\x1b\]11;([^\x07\x1b]*?)(?:\x07|\x1b\\)/);
      if (match) {
        const rgb = parseOSC11Response(match[1]!);
        if (rgb) {
          const lum = computeLuminance(rgb.r, rgb.g, rgb.b);
          pendingDetection = false;
          if (detectionTimer) clearTimeout(detectionTimer);
          applyScheme(lum < 0.5 ? "dark" : "light");
        }
      }
      return true;
    }
    // Ghostty dark/light notifications
    if (data === GHOSTTY_DARK || data.includes(GHOSTTY_DARK)) {
      applyScheme("dark");
      return true;
    }
    if (data === GHOSTTY_LIGHT || data.includes(GHOSTTY_LIGHT)) {
      applyScheme("light");
      return true;
    }
    return false;
  };

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (detectionTimer) clearTimeout(detectionTimer);
    process.stdout.write(GHOSTTY_DISABLE);
  };

  return { inputFilter, queryColorScheme, cleanup };
}

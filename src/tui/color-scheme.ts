/**
 * Terminal color scheme detection and live-watching.
 * Detects light/dark via OSC 11 background color query,
 * and subscribes to Ghostty's mode 2031 notifications.
 */

import { appendFileSync } from "node:fs";

export type ColorScheme = "light" | "dark";

const DEBUG_LOG = "/tmp/itsybitsy-color-debug.txt";

function debugLog(msg: string): void {
  try {
    appendFileSync(DEBUG_LOG, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    // Ignore write errors
  }
}

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
 * Send the OSC 11 background-color query to the terminal.
 * The response will arrive on stdin and should be intercepted by the inputFilter.
 */
function sendOSC11Query(): void {
  debugLog("Sending OSC 11 query");
  process.stdout.write("\x1b]11;?\x07");
}

/**
 * Watch for color scheme changes. Sets up:
 * - An inputFilter to intercept OSC 11 responses and Ghostty mode 2031 notifications
 * - Ghostty notification opt-in and focus reporting
 *
 * IMPORTANT: Call queryColorScheme() AFTER stdin is in raw mode (i.e., after tui.start())
 * to trigger initial detection. The OSC 11 query requires raw mode to receive the response.
 *
 * Returns:
 * - cleanup(): disable notifications
 * - inputFilter: call from the dashboard's input handler BEFORE other key processing
 * - queryColorScheme(): send OSC 11 query (call after tui.start())
 */
export function watchColorScheme(
  onChange: (scheme: ColorScheme) => void
): { cleanup: () => void; inputFilter: InputFilter; queryColorScheme: () => void } {
  let currentScheme: ColorScheme | null = null;
  let pendingDetection = false;
  let detectionTimer: ReturnType<typeof setTimeout> | null = null;

  debugLog("watchColorScheme() called");

  function queryColorScheme(): void {
    pendingDetection = true;
    if (detectionTimer) clearTimeout(detectionTimer);
    detectionTimer = setTimeout(() => {
      if (pendingDetection) {
        pendingDetection = false;
        debugLog("OSC 11 detection timed out after 500ms, defaulting to dark");
        if (currentScheme === null) {
          currentScheme = "dark";
          onChange("dark");
        }
      }
    }, 500);
    sendOSC11Query();
  }

  // Enable Ghostty notifications and focus reporting
  process.stdout.write(GHOSTTY_ENABLE);
  process.stdout.write(FOCUS_ENABLE);
  debugLog("Enabled Ghostty mode 2031 and focus reporting");

  // The input filter intercepts color-scheme escape sequences
  // before they reach normal key handling
  const inputFilter: InputFilter = (data: string): boolean => {
    // Log raw hex for any escape sequences to help debug
    if (data.startsWith("\x1b")) {
      const hex = Buffer.from(data).toString("hex");
      debugLog(`inputFilter received escape sequence: hex=${hex} len=${data.length}`);
    }

    // Check for OSC 11 response: ESC ] 11 ; rgb:... BEL or ST
    if (data.includes("\x1b]11;")) {
      debugLog(`Received OSC 11 response: ${JSON.stringify(data)}`);
      const match = data.match(/\x1b\]11;([^\x07\x1b]*?)(?:\x07|\x1b\\)/);
      if (match) {
        const rgb = parseOSC11Response(match[1]!);
        if (rgb) {
          const lum = computeLuminance(rgb.r, rgb.g, rgb.b);
          const scheme = luminanceToScheme(lum);
          debugLog(`OSC 11 parsed: r=${rgb.r.toFixed(4)} g=${rgb.g.toFixed(4)} b=${rgb.b.toFixed(4)} luminance=${lum.toFixed(4)} scheme=${scheme}`);
          pendingDetection = false;
          if (detectionTimer) clearTimeout(detectionTimer);
          if (scheme !== currentScheme) {
            currentScheme = scheme;
            onChange(scheme);
          }
        } else {
          debugLog(`OSC 11 response did not contain valid RGB: ${match[1]}`);
        }
      } else {
        debugLog("OSC 11 response regex did not match complete sequence");
      }
      return true;
    }

    if (data === GHOSTTY_DARK || data.includes(GHOSTTY_DARK)) {
      debugLog("Received Ghostty dark notification");
      if (currentScheme !== "dark") {
        currentScheme = "dark";
        onChange("dark");
      }
      return true;
    }
    if (data === GHOSTTY_LIGHT || data.includes(GHOSTTY_LIGHT)) {
      debugLog("Received Ghostty light notification");
      if (currentScheme !== "light") {
        currentScheme = "light";
        onChange("light");
      }
      return true;
    }
    if (data === FOCUS_IN || data.includes(FOCUS_IN)) {
      debugLog("Received focus-in event, re-querying OSC 11");
      // Re-detect on focus-in
      queryColorScheme();
      // Don't consume — other handlers may want focus events too
      return false;
    }
    return false;
  };

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (detectionTimer) clearTimeout(detectionTimer);
    process.stdout.write(GHOSTTY_DISABLE);
    process.stdout.write(FOCUS_DISABLE);
    debugLog("cleanup: disabled Ghostty mode 2031 and focus reporting");
  };

  return { cleanup, inputFilter, queryColorScheme };
}

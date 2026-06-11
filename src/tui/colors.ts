/**
 * Shared ANSI escape constants used across the TUI.
 * Import from here instead of defining local copies.
 */

// Reset & modifiers
export const RESET = "\x1b[0m";
export const BOLD = "\x1b[1m";
export const DIM = "\x1b[2m";
export const REVERSE = "\x1b[7m";
export const UNDERLINE = "\x1b[4m";

// Standard colors
export const RED = "\x1b[31m";
export const GREEN = "\x1b[32m";
export const YELLOW = "\x1b[33m";
export const BLUE = "\x1b[34m";
export const MAGENTA = "\x1b[35m";
export const CYAN = "\x1b[36m";
export const WHITE = "\x1b[37m";

// Bright / dim variants
export const DIM_GRAY = "\x1b[90m";
export const BRIGHT_BLUE = "\x1b[94m";
export const BRIGHT_MAGENTA = "\x1b[95m";

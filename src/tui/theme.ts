/**
 * Color theme system for the TUI dashboard.
 * Provides light/dark theme support with runtime switching.
 */

export interface Theme {
  // Base formatting
  reset: string;
  bold: string;
  dim: string;
  reverse: string;

  // Named colors
  red: string;
  green: string;
  yellow: string;
  cyan: string;

  // Agent state colors
  stateCreating: string;
  stateRunning: string;
  stateWaiting: string;
  stateComplete: string;
  stateCompacting: string;
  stateRateLimited: string;
  stateStopped: string;
  stateUnknown: string;

  // Diff colors
  diffMeta: string;
  diffAdd: string;
  diffRemove: string;

  // Log colors
  logTimestamp: string;
  logBracket: string;

  // UI elements
  selectedHighlight: string;
  questionBadge: string;
  usageWarning: string;
  usageCritical: string;
}

export const DARK_THEME: Theme = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  reverse: "\x1b[7m",

  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",

  stateCreating: "\x1b[33m",     // yellow
  stateRunning: "\x1b[32m",      // green
  stateWaiting: "\x1b[36m",      // cyan
  stateComplete: "\x1b[34m",     // blue
  stateCompacting: "\x1b[35m",   // magenta
  stateRateLimited: "\x1b[31m",  // red
  stateStopped: "\x1b[90m",      // dim gray
  stateUnknown: "\x1b[37m",      // white

  diffMeta: "\x1b[2m",
  diffAdd: "\x1b[32m",
  diffRemove: "\x1b[31m",

  logTimestamp: "\x1b[2m",
  logBracket: "\x1b[36m",

  selectedHighlight: "\x1b[7m",
  questionBadge: "\x1b[33m",
  usageWarning: "\x1b[33m",
  usageCritical: "\x1b[31m",
};

export const LIGHT_THEME: Theme = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  reverse: "\x1b[7m",

  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",

  stateCreating: "\x1b[33m",     // yellow
  stateRunning: "\x1b[32m",      // green
  stateWaiting: "\x1b[36m",      // cyan
  stateComplete: "\x1b[34m",     // blue
  stateCompacting: "\x1b[35m",   // magenta
  stateRateLimited: "\x1b[31m",  // red
  stateStopped: "\x1b[90m",      // dim gray
  stateUnknown: "\x1b[30m",      // black (readable on light bg)

  diffMeta: "\x1b[2m",
  diffAdd: "\x1b[32m",
  diffRemove: "\x1b[31m",

  logTimestamp: "\x1b[2m",
  logBracket: "\x1b[36m",

  selectedHighlight: "\x1b[7m",
  questionBadge: "\x1b[33m",
  usageWarning: "\x1b[33m",
  usageCritical: "\x1b[31m",
};

let currentTheme: Theme = DARK_THEME;
const listeners: Set<() => void> = new Set();

export function getCurrentTheme(): Theme {
  return currentTheme;
}

export function setTheme(theme: Theme): void {
  currentTheme = theme;
  for (const cb of listeners) {
    cb();
  }
}

export function onThemeChange(callback: () => void): () => void {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

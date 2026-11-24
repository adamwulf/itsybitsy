/** Collapse text to one line for a log entry: control and format characters and runs of whitespace become single spaces. */
export function singleLine(text: string) {
  return text.replace(/\p{Cc}/gu, " ").replace(/\p{Cf}/gu, "").replace(/\s+/g, " ").trim();
}

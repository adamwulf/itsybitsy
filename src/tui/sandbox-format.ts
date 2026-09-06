import { CYAN, GREEN, RESET, YELLOW } from "./colors";

// Match whole JSON strings so escaped quotes and field-like path text stay intact.
const quoted = '"(?:[^"\\\\\x00-\x1f]|\\\\(?:["\\\\/bfnrt]|u[0-9a-fA-F]{4}))*"';
const record = new RegExp(`^\\[Sandbox\\] ([a-z][a-z0-9*-]*) process=(${quoted})(?: pid=\\d+ birth=\\d+:\\d+)? target=(${quoted}|null)(?: launch=\\S+ boot=\\S+ mach=\\d+)?$`);

/** Compact presentation only; agent.log retains the original attribution fields. */
export function formatSandboxDisplay(line: string): string {
  const match = record.exec(line);
  if (match) {
    const [, operation, process, target] = match;
    const kind = operation!.replace(/^file-read(?:-.*)?$/, "file-read")
      .replace(/^file-write(?:-.*)?$/, "file-write");
    const field = operation!.startsWith("file-") ? "path" : "target";
    line = `[Sandbox] ${kind} process=${process} ${field}=${target}`;
  }
  if (!/^\[Sandbox(?:Proxy)?\] /.test(line)) return line;
  return line.replace(new RegExp(quoted, "g"), value => `${GREEN}${value}${RESET}`)
    .replace(/^(\[Sandbox(?:Proxy)?\]) ((?:denied )?[a-z][a-z0-9*-]*)/, `${CYAN}$1${RESET} ${YELLOW}$2${RESET}`);
}

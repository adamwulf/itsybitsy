import { expect, test } from "bun:test";
import { waitFor } from "../test-utils";

for (const termination of ["SIGTERM", "SIGHUP", "SIGINT", "normal", "graceful"] as const) {
  test(`late Kitty negotiation and ${termination} cleanup use the real ProcessTerminal`, async () => {
    // A subprocess isolates ProcessTerminal's real stdin listeners, signal
    // handlers, raw-mode setup, and global Kitty state from the test runner.
    const script = `
      import { ProcessTerminal } from "@mariozechner/pi-tui";
      import { TypePickerKeyboard } from ${JSON.stringify(`${import.meta.dir}/type-picker-keyboard.ts`)};
      import { installTerminalCleanup } from ${JSON.stringify(`${import.meta.dir}/terminal-cleanup.ts`)};
      const terminal = new ProcessTerminal();
      let focused = false;
      const keyboard = new TypePickerKeyboard(terminal, () => focused);
      const cleanup = installTerminalCleanup(() => { keyboard.stop(); terminal.stop(); });
      terminal.start(data => keyboard.handleInput(data, input => {
        if (input === "t") focused = true;
        if (input === "n") process.exit(0);
        if (input === "q") { cleanup(); cleanup(); process.exit(0); }
      }), () => {});
      keyboard.start();
      process.stdin.on("data", () => {
        if (terminal.kittyProtocolActive) process.stdout.write("READY");
      });
    `;
    const child = Bun.spawn([process.execPath, "--eval", script], {
      cwd: import.meta.dir,
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    let output = "";
    const readOutput = (async () => {
      const reader = child.stdout.getReader();
      const decoder = new TextDecoder();
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        output += decoder.decode(next.value, { stream: true });
      }
    })();
    try {
      await waitFor(() => output.includes("\x1b[?u"));
      // Enter Type focus BEFORE the terminal answers the capability query.
      child.stdin.write("t");
      await child.stdin.flush();
      child.stdin.write("\x1b[?0u");
      await child.stdin.flush();
      await waitFor(() => output.includes("READY"));
      // No further keypress is needed to enable report-all-keys.
      expect(output).toContain("\x1b[>7u\x1b[=24;2uREADY");
      if (termination === "normal" || termination === "graceful") {
        child.stdin.write(termination === "normal" ? "n" : "q");
        await child.stdin.flush();
      } else {
        child.kill(termination);
      }
      await child.exited;
      await readOutput;
      expect(output.match(/\x1b\[<u/g)).toHaveLength(1);
      expect(output.match(/\x1b\[=24;3u/g)).toHaveLength(1);
      expect(await new Response(child.stderr).text()).toBe("");
    } finally {
      child.kill();
      await child.exited;
    }
  });
}

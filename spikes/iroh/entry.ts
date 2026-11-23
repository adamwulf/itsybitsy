// Spike entry. `--version` is the no-op path for check C and never loads the
// addon; every other command reaches iroh through a dynamic import, the way
// `ib watch` would load src/peers/.
const VERSION = "iroh-spike 0.0.1";

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  if (cmd === "--version") {
    console.log(VERSION);
    return;
  }
  const t0 = performance.now();
  const roles = await import("./roles.ts");
  console.log(`[entry] dynamic import of roles.ts took ${(performance.now() - t0).toFixed(1)} ms`);
  // Check E: report if anything keeps the process alive after main returns.
  // The timer is unref'd, so it never keeps the process alive by itself.
  process.on("exit", (code) => console.log(`[entry ${new Date().toISOString()}] process exiting, code ${code}`));
  const finish = () => {
    console.log(`[entry ${new Date().toISOString()}] main returned`);
    setTimeout(() => console.log(`[entry ${new Date().toISOString()}] STILL ALIVE 5 s after main returned`), 5000).unref();
  };
  switch (cmd) {
    case "listen":
      await roles.listen(rest);
      return finish();
    case "dial":
      await roles.dial(rest);
      return finish();
    case "loopback":
      await roles.loopback(rest);
      return finish();
    case "bind-only":
      await roles.bindOnly(rest);
      return finish();
    case "load-only":
      // Check C extra: the cost of loading the addon and doing nothing else.
      return;
    default:
      console.error("usage: entry --version | load-only | listen <keyfile> | dial <id> | loopback | bind-only [--close]  [--net n0|n0-norelay|minimal] [--port N]");
      process.exitCode = 2;
  }
}

await main(process.argv.slice(2));

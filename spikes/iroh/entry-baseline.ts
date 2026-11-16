// Check C baseline: entry.ts with the iroh dynamic import removed. Everything
// on the --version path is identical, so the size and startup difference
// between the two builds is the cost of carrying the addon.
const VERSION = "iroh-spike 0.0.1";

async function main(argv: string[]): Promise<void> {
  const [cmd] = argv;
  if (cmd === "--version") {
    console.log(VERSION);
    return;
  }
  console.error("baseline build: only --version is available");
  process.exitCode = 2;
}

await main(process.argv.slice(2));

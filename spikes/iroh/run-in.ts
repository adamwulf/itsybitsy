// Run a command with a given working directory, stdio inherited.
// Usage: bun spikes/iroh/run-in.ts <dir> <command> [args...]
// The spike's harness forbids `cd`, so this sets the child's cwd instead.
const [dir, ...cmd] = process.argv.slice(2);
if (!dir || cmd.length === 0) {
  console.error("usage: run-in.ts <dir> <command> [args...]");
  process.exit(2);
}
const proc = Bun.spawn(cmd, { cwd: dir, stdio: ["inherit", "inherit", "inherit"] });
process.exitCode = await proc.exited;

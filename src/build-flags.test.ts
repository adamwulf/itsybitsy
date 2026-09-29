import { describe, expect, test } from "bun:test";
import { join } from "path";

// The compiled `ib` must not autoload `.env` / `bunfig.toml`. By default a
// compiled Bun binary scans its cwd's ancestors for them at startup; inside a
// sandboxed agent those directories are unreadable and Bun then starts with an
// EMPTY environment (no PATH → `Executable not found in $PATH: "tmux"`).
// Measured under a real agent profile: default build 0 env vars, with these
// flags all of them. A `.env` in an agent worktree must also not be able to
// change ib's environment. See AGENTS.md "Building the `ib` binary".
const REQUIRED_FLAGS = ["--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig"];
const root = join(import.meta.dir, "..");

async function agentsMdBuildCommand(): Promise<string> {
  const text = await Bun.file(join(root, "AGENTS.md")).text();
  const block = text.match(/```sh\n(bun build --compile[^\n]*)\n```/);
  if (!block) throw new Error("AGENTS.md has no `bun build --compile` command block");
  return block[1]!;
}

describe("ib build command", () => {
  test("package.json build script disables dotenv and bunfig autoload", async () => {
    const pkg = await Bun.file(join(root, "package.json")).json();
    for (const flag of REQUIRED_FLAGS) expect(pkg.scripts.build).toContain(flag);
  });

  test("AGENTS.md documents exactly the package.json build script", async () => {
    const pkg = await Bun.file(join(root, "package.json")).json();
    expect(await agentsMdBuildCommand()).toBe(pkg.scripts.build);
  });

  test("build.sh disables dotenv and bunfig autoload", async () => {
    const script = await Bun.file(join(root, "build.sh")).text();
    const command = script.split("\n").find((line) => line.startsWith("bun build --compile"));
    expect(command).toBeDefined();
    for (const flag of REQUIRED_FLAGS) expect(command).toContain(flag);
  });
});

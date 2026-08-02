// Re-export from src/index.ts — this file exists for package.json "module" field
export * from "./src/index";

import { main } from "./src/index";

// This file is also a CLI entry point: CLAUDE.md builds the `ib` binary with
// `bun build --compile ... index.ts`, i.e. from HERE, not from src/index.ts.
// src/index.ts guards its own dispatch behind `import.meta.main`, which is false
// there when it is reached through this re-export, so without the call below a
// binary built per CLAUDE.md would start up and dispatch nothing.
//
// Guarded so that importing the package root (the "module" field above) stays a
// pure import with no side effects — that inertness is the whole point of the
// guard in src/index.ts.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

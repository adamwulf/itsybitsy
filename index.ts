// Re-export surface for `import ... from "itsybitsy"`.
// (package.json's "module" field points at src/index.ts, not at this file.)
export * from "./src/index";

import { main } from "./src/index";

// This file's real job is being the CLI entry point: the `ib` binary is built
// with `bun build --compile ... index.ts`, i.e. from HERE, not from
// src/index.ts. src/index.ts guards its own dispatch behind `import.meta.main`,
// which is false there when it is reached through the re-export above, so
// without the call below the compiled binary would start up and dispatch
// nothing at all — silently, exit 0, no output.
//
// Guarded so that importing this module stays a pure import with no side
// effects — that inertness is the whole point of the guard in src/index.ts.
if (import.meta.main) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

#!/bin/bash
set -e

# The --no-compile-autoload-* flags are required: without them the binary starts
# with an empty environment inside a sandboxed agent (see AGENTS.md).
# --bytecode halves ib's startup CPU; --format=esm keeps the bundle strict-mode
# ESM, which --bytecode alone would turn into sloppy-mode CommonJS (see AGENTS.md).
bun build --compile --sourcemap --keep-names --bytecode --format=esm --no-compile-autoload-dotenv --no-compile-autoload-bunfig index.ts --outfile ib
echo "Built: $(pwd)/ib"

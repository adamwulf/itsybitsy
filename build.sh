#!/bin/bash
set -e

# The --no-compile-autoload-* flags are required: without them the binary starts
# with an empty environment inside a sandboxed agent (see AGENTS.md).
bun build --compile --sourcemap --keep-names --no-compile-autoload-dotenv --no-compile-autoload-bunfig index.ts --outfile ib
echo "Built: $(pwd)/ib"

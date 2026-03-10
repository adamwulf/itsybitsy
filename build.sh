#!/bin/bash
set -e

bun build --compile --minify --sourcemap index.ts --outfile ib
echo "Built: $(pwd)/ib"

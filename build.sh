#!/bin/bash
set -e

bun build --compile --sourcemap --keep-names index.ts --outfile ib
echo "Built: $(pwd)/ib"

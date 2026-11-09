#!/bin/bash

# Rebuild ib and run `ib watch`; when it exits, count down and do it again.
# Work merged into this checkout takes effect the next time `ib watch` quits,
# for example when the system coordinator runs `ib bounce`.
# Ctrl-C during the countdown stops the loop.
#
# A failed build keeps the previous ./ib binary, so a broken merge still
# relaunches the last good `ib watch` instead of leaving you without one.

cd "$(dirname "$0")" || exit 1

while true; do
  if ! ./build.sh; then
    echo "Build failed; relaunching the previous ib."
  fi

  ./ib watch

  for i in 5 4 3 2 1; do
    printf '\rRebuilding and relaunching ib watch in %ds (Ctrl-C to stop) ' "$i"
    sleep 1
  done
  echo
done

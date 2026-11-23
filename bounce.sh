#!/bin/bash

# Pull, rebuild ib and run `ib watch`; when it exits, count down and do it
# again. Work merged into this checkout, or pushed to its remotes, takes effect
# the next time `ib watch` quits, for example when the system coordinator runs
# `ib bounce`. Hooks and agents run the `ib` on PATH, so that must be this
# checkout's ./ib.
# Ctrl-C during the countdown stops the loop.
#
# A failed pull (uncommitted changes, main not checked out, no fast-forward)
# builds what is already checked out. A failed build keeps the previous ./ib
# binary, so a broken merge still relaunches the last good `ib watch` instead
# of leaving you without one.

cd "$(dirname "$0")" || exit 1

while true; do
  # `./` resolves to this checkout's path, so no repo id is needed. A fresh
  # clone has no ./ib until the first build, so it skips the pull.
  if [ -x ./ib ]; then
    if ! ./ib pull ./; then
      echo "Pull failed; building what is checked out."
    fi
  fi

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

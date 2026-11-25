#!/bin/bash

# Pull, rebuild ib and run `ib watch`; when it exits, count down and do it
# again. Work merged into this checkout, or pushed to its remotes, takes effect
# the next time `ib watch` quits, for example when the system coordinator runs
# `ib bounce`. Hooks and agents run the `ib` on PATH, so that must be this
# checkout's ./ib.
# Ctrl-C during the countdown stops the loop.
#
# A failed pull (uncommitted changes, main not checked out, no fast-forward)
# builds what is checked out. A failed build keeps the previous ./ib
# binary, so a broken merge still relaunches the last good `ib watch` instead
# of leaving you without one.
#
# Crash records (SPEC §8.14). `ib watch` writes its own [crash] and [exit]
# lines to watch.log, but a native crash (a Bun panic, a segfault in a napi
# addon) kills it before any JS runs. So after each run this script appends
# how it ended to watch.log, and it keeps a copy of `ib watch`'s stderr, where
# Bun prints a panic, in watch-stderr.log while still showing it here.

cd "$(dirname "$0")" || exit 1

# The file `ib watch` logs to, which honors the same override.
WATCH_LOG="${IB_WATCH_LOG_PATH:-$HOME/.itsybitsy/watch.log}"
STDERR_LOG="$HOME/.itsybitsy/watch-stderr.log"
# Past this size watch-stderr.log moves to watch-stderr.log.1 (replacing it)
# before the next launch, so the two stay near 4 MB together.
STDERR_LOG_MAX_BYTES=2097152

utc_now() {
  date -u +%Y-%m-%dT%H:%M:%SZ
}

# "status 0", or for a death by signal N (status 128+N) "status 139 (signal
# 11, SIGSEGV)"; 134 is SIGABRT, Bun's abort after a panic.
describe_exit() {
  local status=$1 sig name
  if [ "$status" -gt 128 ]; then
    sig=$((status - 128))
    name=$(kill -l "$sig" 2>/dev/null)
    if [ -n "$name" ]; then
      echo "status $status (signal $sig, SIG${name#SIG})"
    else
      echo "status $status (signal $sig)"
    fi
  else
    echo "status $status"
  fi
}

rotate_stderr_log() {
  local size
  [ -f "$STDERR_LOG" ] || return 0
  size=$(wc -c < "$STDERR_LOG")
  if [ "$size" -gt "$STDERR_LOG_MAX_BYTES" ]; then
    mv -f "$STDERR_LOG" "$STDERR_LOG.1"
  fi
}

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

  mkdir -p "$(dirname "$WATCH_LOG")" "$(dirname "$STDERR_LOG")"
  rotate_stderr_log
  echo "===== $(utc_now) bounce.sh launching ib watch =====" >> "$STDERR_LOG"

  # The process substitution keeps ./ib watch a direct child of this script,
  # which `ib bounce` requires. tee -i ignores SIGINT: a Ctrl-C while ib watch
  # shuts down (which ib watch ignores) must not kill tee and leave ib watch
  # writing to a closed pipe.
  ./ib watch 2> >(tee -i -a "$STDERR_LOG" >&2)
  status=$?
  echo "$(utc_now) [bounce.sh] ib watch exited with $(describe_exit "$status")" >> "$WATCH_LOG"

  for i in 5 4 3 2 1; do
    printf '\rRebuilding and relaunching ib watch in %ds (Ctrl-C to stop) ' "$i"
    sleep 1
  done
  echo
done

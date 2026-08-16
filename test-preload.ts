/**
 * Global `bun test` preload (wired in via bunfig.toml `[test].preload`).
 *
 * Redirects the ib-watch diagnostic log away from the developer's real
 * ~/.itsybitsy/watch.log for the ENTIRE test run. logToWatchLog is reached
 * transitively by many code paths under test (orphan reaping, coordinator
 * refcount pruning, lifecycle teardown), and any of them writing to the live
 * log pollutes it. watch-log.ts reads IB_WATCH_LOG_PATH as its default path, so
 * setting the env here — before any module loads — makes both the default and
 * whatever resetWatchLogPath() restores to point at a throwaway temp file.
 *
 * The temp path deliberately ends in `.itsybitsy/watch.log` so watch-log's own
 * "reset restores the default" assertion (which matches /\.itsybitsy\/watch\.log$/)
 * still holds. Individual tests that call setWatchLogPath() to a per-test temp
 * file continue to work unchanged.
 */
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

if (!process.env.IB_WATCH_LOG_PATH) {
  const base = mkdtempSync(join(tmpdir(), "ib-test-home-"));
  process.env.IB_WATCH_LOG_PATH = join(base, ".itsybitsy", "watch.log");
}

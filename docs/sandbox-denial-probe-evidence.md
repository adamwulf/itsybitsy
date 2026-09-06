# Live kernel sandbox denial — evidence report

Author: worker `agent-9685061d` (branch `agent/agent-9685061d`, forked from
`agent/sandbox-denial-logs`). Dates: 2026-09-05 (probe) and 2026-09-06 (collector
validation). Host: Darwin 25.5.0 (arm64), single macOS host, one boot (`bootUUID`
7908F0D7-...). Findings are single-host observations; timing numbers are
environment-dependent.

**Document map — two distinct efforts:**
- **§1–§9 — Historical capability probe** (2026-09-05): a diagnostic probe of the
  raw OS behavior via the branch-inherited `scripts/probe-sandbox-denials.ts`. It
  establishes what the unified log reports, attribution limits, and startup-delay
  behavior. It is **not** a test of the collector implementation.
- **§10 — Failed collector candidate** (`008c233`): two blocking adapter defects
  found live; **its isolated-proof claims are qualified in place** — those
  experiments established four observed pipeline records, not a compiled-candidate
  pass. History preserved.
- **§11 — Corrected collector candidate** (`f09280f`): the authorized live set run
  through the **compiled** candidate; per-axis results and a further visibility
  defect (Defect 3).
- **§12 — Real-preamble validation + Defect 3 fix** (`d198c4d`): the REAL
  `sandboxDenialScriptPreamble` run verbatim in `start.sh`/`resume.sh` fixtures,
  the Defect 3 fix verified live, collector/stream topology, and collector-SIGKILL
  residual/orphan behavior. This is the most current collector validation.

None of this is a full acceptance pass: single host, synthetic sandboxed offenders
(not the real CLIs/proxy). §12 runs the real preamble/gate verbatim, but still in a
minimized harness (no proxy, no real CLI; production `start.sh`/`resume.sh` bodies
not executed whole).

This report answers the capability investigation in
`docs/SANDBOX-ROLLOUT.md` → "Next phase: collect kernel sandbox denials". The
prior Codex session could not apply a Seatbelt profile (exit 71) or read the
unified log (exit 64). This worker's context permits both, so the live probe ran.

## 1. Capability status (this worker's context)

Both operations that blocked the Codex session succeed here:

| Command | Codex session | This worker |
|---|---|---|
| `/usr/bin/sandbox-exec -p "(version 1) (allow default)" /usr/bin/true` | exit 71 `sandbox_apply: Operation not permitted` | **exit 0** |
| `/usr/bin/log stream` (2s timeout, no-match predicate) | exit 64 `Cannot run while sandboxed` | **exit 0**, streamed cleanly |

Note: `/usr/bin/log help stream` returns exit **64** here too, but that is the
normal `EX_USAGE` code for the `help` subcommand printing usage — **not** the
Codex "Cannot run while sandboxed" failure. The real capability signal is that
`log stream` (and `log show`) actually run and produce output here. My session's
SessionStart states "The kernel sandbox is OFF" for this worker, consistent with
being able to both apply a profile and read the log.

## 2. What ran

Command: `bun scripts/probe-sandbox-denials.ts --run` (the branch-inherited
probe; not modified). Artifact dir: `…/T/ib-denial-probe-E8o8ss`.

The probe generated a Seatbelt profile from the shipped floor
(`docs/agent-types/_all.md` `paths`/`sandbox`) via the production
`generateProfile`, with an explicit `deny file-read*`/`file-write*` on a
disposable `forbidden/` subdir. Confirmed profile lines (canonicalized target):

```
(deny file-read*  (subpath ".../ib-denial-probe-E8o8ss/forbidden"))
(deny file-write* (subpath ".../ib-denial-probe-E8o8ss/forbidden"))
```

The parent temp root is under `/private/var/folders` (allowed read+write); only
`forbidden/` is denied — so a denied read/write is isolated to the fixture.
Path canonicalization matters: `/var/folders` → `/private/var/folders`; a
non-canonical `subpath` silently fails to match and denies nothing (I hit this in
a side experiment and corrected it with `realpath`).

## 3. Cases, exits, and enforcement (from `observations.json` + stderr)

| Case | pid | exit | Result |
|---|---|---|---|
| `sandbox-capability` (allow-default → `/usr/bin/true`) | 96726 | 0 | profile applies |
| `generated-profile-boot` (floor profile → `/usr/bin/true`) | 96727 | 0 | **our floor profile applies cleanly** |
| `startup-read` (floor profile → `cat forbidden/read.txt`) | 96728 | 1 | **read DENIED** |
| `short-lived-children` (parent sh forks read+write child) | 96729 | 1 | **child read + child write DENIED** |

- `startup-read` stderr: `cat: …/forbidden/read.txt: Operation not permitted`,
  stdout empty. Kernel `EPERM`, not an app-level error.
- `short-lived-children` stdout: `parent=96729 / read-child=96730 / write-child=96731`.
  stderr: `cat: …/read.txt: Operation not permitted` and
  `sh: …/write.txt: Operation not permitted`.
- **`writeCreated: false`** and `ls forbidden/` shows only the fixture `read.txt`:
  the denied write **never created a file** — real enforcement, not just a message.
- `log stream` never crashed (`streamExitCode: null` at kill; 0 bytes stderr).

Both a **forbidden read and a forbidden write fail under the generated floor
profile**, including subprocess operations that do not touch the advisory hook
scanner. Short-lived children (spawned and exited within ~35 ms) are enforced.

## 4. Real violation reports appear — exact raw event fields

`events.ndjson` (live, 2 s warmup) captured **3 fixture events** plus 1 unrelated
system event (see §7). The persisted store (`log show --last 10m` scoped to the
fixture marker, `--info --debug`) returned the **same 3** and nothing richer.

Sanitized real events (fixture paths are disposable; nothing else redacted):

```json
{"messageType":"Error","subsystem":"","category":"","userID":0,
 "processID":0,"processImagePath":"/kernel",
 "senderImagePath":"/System/Library/Extensions/Sandbox.kext/Contents/MacOS/Sandbox",
 "threadID":75214711,"machTimestamp":43149983861291,
 "timestamp":"2026-09-05 23:01:34.988314-0500",
 "eventMessage":"Sandbox: cat(96728) deny(1) file-read-data /private/var/folders/…/ib-denial-probe-E8o8ss/forbidden/read.txt"}

{ … "eventMessage":"Sandbox: cat(96730) deny(1) file-read-data …/forbidden/read.txt"}    // short-lived read child
{ … "eventMessage":"Sandbox: bash(96731) deny(1) file-write-create …/forbidden/write.txt"} // short-lived write child
```

Field breakdown (every fixture event has the same shape):

- `messageType`: `"Error"`.
- `subsystem`: **empty string**. `category`: **empty string**. The stream's first
  predicate clause `(subsystem == "com.apple.sandbox.reporting" AND category ==
  "violation")` matched **zero** events; **all** matched via the free-text
  `eventMessage CONTAINS "Sandbox:"` clause. On this OS the kernel emits the
  violation as an unstructured log line, and no userspace
  `com.apple.sandbox.reporting` structured "violation" event was produced for
  these `sandbox-exec` denials.
- `processID`: **0** — this is the **reporter** (kernel), not the offender.
- `processImagePath`: `/kernel`; `senderImagePath`: the Sandbox kext.
- `userID`: **0** — reporter context, not the offender's uid.
- `eventMessage`: the **only** place the offender appears, as free text:
  `Sandbox: <comm>(<pid>) deny(1) <operation> <path>`.
- Operations observed: `file-read-data` (read) and `file-write-create` (write).
- Timing: `machTimestamp` (monotonic) is authoritative; the walltime `timestamp`
  jittered ~0.5 ms between the live and persisted renderings of the *same* event
  (same `machTimestamp` 43149983861291). Order by `machTimestamp`, not walltime.
- Also present but not offender-identifying: `threadID` (kernel thread), `traceID`,
  `senderProgramCounter`, `backtrace` (kernel image offset), `bootUUID`.

## 5. Reporter vs offender identity — the attribution answer

**The event does not carry offender birth/audit identity.** For every denial the
reporter is the kernel (`processID: 0`, `processImagePath: /kernel`,
`senderImagePath` = Sandbox.kext). The **only** offender evidence is the
`<comm>(<pid>)` pair embedded as free text in `eventMessage`. Specifically absent:

- No audit token / audit session id for the offender.
- No parent PID, no responsible PID, no process ancestry.
- No offender uid (the `userID` field is the reporter's, 0).
- No offender image path — only the leaf `comm` short name (e.g. `cat`, `bash`).
  Note the write child was `exec`'d as `/bin/sh -c …` but reported as `bash`
  (macOS `/bin/sh` is bash): the reported name is the running image's `comm`, not
  the launcher's intent, so name-matching to a CLI is unreliable.

I queried the persisted store with `--info --debug` scoped to the fixture marker
to check for a richer report; only the same 3 kernel lines exist. **There is no
second, structured violation record with more fields.**

**Conclusion:** attribution from these events is limited to string-parsing
`(comm, pid)` out of `eventMessage`. That is **insufficient on its own** to
attribute a denial to a specific agent launch, because:

1. `pid` is reused by the OS, and the event has no audit token to disambiguate.
2. Short-lived offenders exit within ~35 ms (measured), so sampling `/proc`-style
   process state after the fact often finds the pid already gone or reused.
3. `comm` is the leaf binary (`cat`/`bash`), never the agent CLI identity.

A collector must therefore correlate the reported `pid` against an
**independently maintained** descendant-set of the wrapped CLI captured at (or
before) report time — and must **leave events it cannot confidently place as
unattributed** rather than guess. PID/name sampling alone cannot safely resolve
delayed reports, PID reuse, or children that exit between samples. Do not claim a
complete audit; missing/unattributable events are an inherent limitation.

## 6. Startup delay and flood behavior (readiness + drop limits)

Kernel **enforcement** was 100% reliable at every delay; the variable is whether
`log stream` **captures** (reports) the denial, since the stream is live-only and
does not backfill events that occur before its subscription is established.

Boundary — fresh stream, **0 ms** warmup, single denial, ×8
(`ib-flood-probe`, delay0 loop):

- kernel denied: **8/8**; stream captured: **2/8** (`[1,0,0,0,0,0,0,1]`).
- → With no warmup, ~75% of startup denials were **enforced but not reported**.

Threshold — fresh stream, ×6 each (`ib-thresh-probe`):

| warmup | kernel denied | stream captured |
|---|---|---|
| 50 ms | 6/6 | **6/6** |
| 250 ms | 6/6 | 6/6 |
| 500 ms | 6/6 | 6/6 |
| 1000 ms | 6/6 | 6/6 |

- → The readiness gap is short (< 50 ms here) but **nonzero**. Any modest warmup
  was reliable; only a true ≈0 ms warmup dropped reports. The probe's 2 s delay
  captured everything (§4) and is generous, but "2 s" is not the meaningful
  number — **"warm before the workload runs" is**, and it is not guaranteed by a
  fixed sleep.

Flood — one **warm** stream, 40 denials from 40 distinct pids fired back-to-back
(`ib-flood-probe`): captured **40/40**, distinct pids **40/40**, **0** coalesced.
→ Distinct-process denials are not dropped when the stream is warm.

Coalescing — the OS *does* coalesce **same-process, same-operation** repeats: the
one unrelated system event (§7) arrived as `"1 duplicate report for Sandbox: …"`.
→ A single wedged process hammering one denied path is summarized by the OS into
`N duplicate report` lines; distinct processes each get their own line. A
collector's dedup must handle both the OS-side `duplicate report` prefix and its
own overlap, and must treat dropped/coalesced events as a known gap.

Delayed reports: the probe held the stream 10 s after the children exited. No
additional fixture events arrived beyond the three delivered promptly (each within
~1 ms of the offending syscall). No evidence of long-delayed delivery for these
denials on this host.

## 7. Unrelated-event note (disclosure hygiene)

The broad predicate also matched one unrelated background macOS daemon's
`user-preference-read` denial, delivered as a `"1 duplicate report for Sandbox: …"`
line. It is **not** part of the fixture and is redacted here beyond noting its
shape (it is the evidence for OS-side same-process coalescing in §6). This
confirms the rollout doc's warning: the raw predicate captures unrelated system
sandbox reports, so a production collector must scope/attribute, not log the raw
stream verbatim. Separately, `log show` records its **own** invocation, so a
query whose predicate text contains a marker will match that marker in the log
tool's command-line record — a self-referential artifact, not a sandbox event.

## 8. Reproduction

```sh
# Capability preconditions (must both succeed):
/usr/bin/sandbox-exec -p "(version 1) (allow default)" /usr/bin/true    # exit 0
/usr/bin/log stream --style compact --timeout 2s --predicate 'eventMessage CONTAINS "no_match"'  # exit 0

# Primary probe (branch-inherited; prepares an isolated fixture, then runs):
bun scripts/probe-sandbox-denials.ts --run
# Inspect (do NOT trust exits alone): events.ndjson, observations.json,
#   startup-read.stderr, short-lived-children.stderr, ls forbidden/
# Re-query the persisted store, scoped to the run's fixture dir name:
/usr/bin/log show --last 10m --style ndjson --info --debug \
  --predicate 'eventMessage CONTAINS "<ib-denial-probe-XXXX dirname>"'
```

Delay/flood/threshold experiments used small standalone scripts (kept in this
worker's scratchpad, not committed): each starts a fresh `log stream`, waits a
warmup, triggers a canonicalized-path denial under a minimal
`(allow default)(deny file-read* (subpath …))` profile, drains, and counts
captured events by offender pid.

## 9. Bottom line for the collector design

1. Kernel enforcement of the generated floor profile is solid for reads, writes,
   and short-lived subprocesses (measured; `write.txt` never created).
2. Denials **are** reported to the unified log as kernel `Sandbox.kext` `Error`
   lines; capture requires `log stream`/`show` with a `eventMessage CONTAINS
   "Sandbox:"` predicate (the structured `com.apple.sandbox.reporting` clause did
   not fire on this OS).
3. **No offender audit/birth identity exists in the event** — only `(comm, pid)`
   free text; the structured fields describe the kernel reporter. Attribution
   must correlate pid against an independently tracked CLI descendant set and
   leave uncertain events unattributed.
4. The collector must be started and **confirmed warm before** the wrapped CLI;
   a fixed short sleep is not a readiness guarantee (0 ms warmup lost ~75% of
   reports while every denial was still enforced). Prefer a readiness handshake
   (e.g. self-emit a marker and wait to observe it) over a magic delay, and
   document earliest-startup reports as best-effort.
5. Treat OS coverage as best-effort diagnostic logging: same-process floods are
   OS-coalesced, and dropped/unattributable events must remain explicit limits —
   not a claim of complete audit.

## 10. Live test of the collector candidate (`ib sandbox-log-watch`)

Tested candidate `008c233` on `agent/sandbox-denial-logs` (native reader and
readiness source unchanged since `5eabf9f`), rebuilt locally (`bun run build`,
not installed) and driven by a bun orchestrator that spawns the real collector
binary and the real gate helper (`sandboxDenialExecPrefix`, recovered verbatim)
as direct children of the owner, against the real generated floor profile.

### Boot identity (as the manager noted)

Live `log stream` records on Darwin 25 carry `bootUUID` as an **empty string**;
only `log show` (persisted) and the native `sysctl(kern.bootsessionuuid)` provide
the actual boot (`7908f0d7-…`, lowercased). The collector therefore binds
empty-bootUUID live events to its independently read boot — verified: the native
adapter's boot equals the persisted-log boot. `parseSandboxReport` accepts an
empty `bootUUID` only under `liveStream`, and rejects persisted/replayed input
that lacks a boot identity.

### Two blocking defects in the native adapter (`src/sandbox-processes.ts`)

Both were found live and reproduced in isolation. An end-to-end run of the
**unmodified** `src` attribution pipeline with a locally corrected adapter then
produced correct records (below). **Qualification (per manager self-review):** that
isolated run establishes only the four observed pipeline records under a corrected
adapter — it does **not** by itself prove these were the *only* defects, nor that
the *compiled* candidate or the remaining scenarios pass. Those required
independent measurement on the corrected compiled candidate, which is §11 (and
which did surface a further defect, §11 Defect 3).

1. **Wrong mach clock — attribution never matches.** `openSandboxProcessReader()`
   brackets observed lifetimes with `mach_absolute_time()`, but the kernel sandbox
   log stamps events with **`mach_continuous_time`** (which advances through system
   sleep). On any machine that has slept since boot, `report.mach` is offset from
   the `[first,last]` interval by the accumulated sleep time, so `attribute()`
   returns null for **every** real denial — zero `[Sandbox]` records even for a
   fully observed root. Evidence (walltime-anchored, unique marker): a real event
   `machTimestamp=43233526391014` fell **inside** the continuous bracket
   `[43233525855097, 43233574750302]` and **outside** the absolute bracket
   `[39466358872503, 39466407769032]` (off by ~3.77e12 ticks ≈ total sleep).
   Fix: use `mach_continuous_time` for the adapter's `clock`.
2. **`proc_listchildpids` return misread — descendants never enumerated.**
   `children()` computes `Math.floor(ret/4)` treating the return as a byte count,
   but on Darwin 25 `proc_listchildpids` returns a **pid count**. So 1–3 children
   collapse to `[]`; the sampling queue never grows past the root; descendant
   offenders are never observed, so descendant denials are never attributed. In
   production the CLI root rarely performs the denied I/O itself — its child tools
   do — so this alone would miss almost everything even after Defect 1 is fixed.
   Evidence: a parent with two live children → `proc_listchildpids` returned `2`
   with `buf[0..1]` = the real child pids, while `proc_listpids(PROC_PPID_ONLY)`
   returned `8` (bytes) for the same two. Fix: treat the return as a count
   (`buf.subarray(0, ret)` with a `p>0` filter, and change the overflow guard from
   `>= byteLength` to `>= capacity`), or switch to `proc_listpids(PROC_PPID_ONLY)`
   (documented byte return).

**Isolated evidence the two fixes are on the right track (real pipeline, real
kernel events).** With both fixes applied to a local adapter and the unmodified
`SandboxAttribution` / `parseSandboxReport` / `formatSandboxRecord`, a root that
does builtin read+write and an observable descendant shell produced **4 correctly
attributed** records: root pid file-read-data + file-write-create, and descendant
pid (distinct birth) file-read-data + file-write-create — correct operation,
target, birth, boot, and mach. This is isolated evidence only; it does not stand
in for the compiled-candidate run in §11.

### Attribution timing constraints (kept visible)

- The root/descendant must be **observed before it denies** for the interval to
  bracket the report. The launch gate guarantees this for the root via the
  `root-request`/`root-ready` handshake (registration precedes `exec`). A
  descendant that denies within its first ~20 ms (before the sampling loop sees
  it) has no observed interval covering the report and is **dropped, not guessed**
  — the intended behavior for immediate/short-lived children.
- Offenders must also stay observable **after** a denial so `last` extends past
  `report.mach`. Order records by `mach`; the walltime string can jitter.

### Clock/children-independent axes that passed on `008c233`

- **Readiness handshake** (emit a `logger` marker, wait to observe it) works — no
  reliance on a fixed sleep. Confirms §9.4's recommendation is implemented.
- **Enforcement** under the floor profile: root builtin read and write both EPERM,
  `write.txt` never created; short-lived children EPERM.
- **CLI-exit cleanup** (the `008c233` fix): when the registered root exits while
  the owner stays alive (simulated interactive exit-check), the collector drained
  and removed **only its own** launch directory at ~1050 ms (~1 s), logging
  `collector stopped`.
- **Startup failure** (bad owner): collector exits 1, appends a visible
  `[SandboxCollector] ERROR: …; kernel enforcement remains required` to
  `agent.log`, removes its own directory — and the kernel still enforced the
  offender (EPERM, no file). Collection failure is visible; enforcement intact.
- **SIGTERM teardown**: ~1033 ms drain, own-directory removal, `collector stopped`
  INFO, exit 0.
- **DENIALS parser**: the emitted `[Sandbox] <op> process=… pid=… target=…` record
  shape matches `parseDenials`'s new pattern; `[SandboxCollector] ERROR/WARNING`
  lines are recognized too.

### Still blocked (to re-test on the corrected candidate)

End-to-end scenarios through the `ib` binary — root-builtin attribution, observable
descendant attribution, immediate-children dropped-not-guessed, and concurrent
no-cross-attribution — currently emit zero `[Sandbox]` records because of Defects
1+2, so their live confirmation is deferred until the corrected candidate. The
isolated evidence above is suggestive but not a substitute; the compiled-candidate
results are in §11.

## 11. Corrected collector candidate — live results (`f09280f`)

Candidate `f09280f` applies both §10 fixes (verified in `src/sandbox-processes.ts`:
`mach_continuous_time` for the clock; `decodeSandboxChildPids` treats the
`proc_listchildpids` return as a pid count with a `>= buffer.length` overflow
guard). Rebuilt locally (`bun run build`, not installed) and driven through the
**compiled** `ib sandbox-log-watch` binary plus the real gate helper. (A later
tip `ea01cee` is test-only; production is identical to `f09280f`.)

Method: a bun orchestrator spawns the compiled collector and the real gate
(`sandboxDenialExecPrefix`, recovered verbatim) as direct children of the owner,
against the generated floor profile with an explicit `forbidden/` deny. No
dashboard and no watchdog run in any fixture — collection is driven by the
launch/collector alone (independence requirement satisfied by construction).

### Per-axis results

| Axis | Result |
|---|---|
| Root builtin read+write, held alive | **Attributed** — 2 `[Sandbox]` records, correct pid/birth/target/op/mach |
| Observable descendant shell (observed before it denies) | **Attributed** to the descendant pid (distinct from root) — descendant enumeration works |
| Immediate `cat` children (deny at ~0 ms, exit at once) | **Dropped, not guessed** — enforced (EPERM), zero records |
| Concurrent (2 launches, distinct forbidden dirs) | **Isolated** — each `agent.log` holds only its own denials; no cross-attribution |
| Replacement vs late old cleanup | Old launch tears down (removes only its own dir) while the replacement stays ready, attributes its own denials, and removes only its own dir |
| Enforcement | read + write both EPERM; `write.txt` never created; short-lived children blocked |
| CLI-exit cleanup (the `008c233` fix) | Collector drains and removes **only its own** dir ~1050 ms after the root exits, owner still alive |
| SIGTERM teardown | ~1027 ms drain, own-dir removal, `collector stopped`, exit 0 |
| Startup failure (non-ancestor owner) | Exit 1, visible `[SandboxCollector] ERROR` in `agent.log`, own dir removed, kernel still enforces |
| `parseDenials` + real DENIALS pane | Real captured `agent.log` → `parseDenials` extracts `[Sandbox]` records (finite epoch) and `[SandboxCollector] ERROR`/`WARNING`, **excludes** `INFO`; `RightPaneComponent.render()` shows an "N denial(s)" header + rows. Collector failures are visible in the pane. |

Attribution requires the offender **observed before it denies** (the gate's
`root-request`/`root-ready` handshake guarantees this for the root; the ~20 ms
sampling loop must catch a descendant before its first denied op) and **held alive
after** so `last` brackets `report.mach`. Records are keyed by pid + birth, so the
reported leaf `comm` (`bash`) never needs to match the launching CLI.

### Defect 3 (visibility gap; present on `008c233` and `f09280f`)

The collector detects `log stream` death only via `stream.exitCode !== null` (the
startup guard and the main-loop guard). A `log stream` terminated by a **signal**
(crash, OOM, `SIGKILL`/`SIGTERM`) sets `signalCode` and leaves `exitCode` null
(verified: `Bun.spawn` + `SIGKILL` → `{exitCode:null, signalCode:"SIGKILL"}`).
Live: the collector's only child was SIGKILLed (confirmed it was the log stream —
the collector then had no children and none reappeared), yet the collector kept
running, collected nothing further, and exited 0 with `collector stopped` and **no
ERROR**. So a signal-terminated stream is invisible, violating "collection failure
must be visible." A stream that **exits with a code** is still detected. Fix: treat
`signalCode !== null` as failure too, in both guards. **Fixed in `d198c4d`
(shared `sandboxStreamExited`) and verified live — see §12.**

### Explicit limits / untested axes

- The real `start.sh`/`resume.sh` **bash preamble** (`sandboxDenialScriptPreamble`)
  was **not** run verbatim: the real gate helper was used verbatim, but the
  preamble's collector launch (mktemp + background + ready-wait) was replicated in
  the orchestrator, and the owner is the orchestrator process (a valid ancestor),
  not a real `start.sh`. The preamble text is covered by unit tests + baseline
  fixtures, not by this live run.
- Not tested with the real `claude`/`codex`/`agy` CLIs or the per-agent proxy —
  offenders are synthetic sandboxed shells/`cat` producing the same kernel denials.
- Concurrent used one owner (the orchestrator) for both collectors with distinct
  dirs; isolation is by root-tree + own-dir, which is what was validated — not two
  independent `start.sh` owners.
- No PID-reuse claim from a single live run; birth identity guards it in the
  algorithm but was not exercised against a real reuse.
- The immediate-child drop boundary is timing-dependent (~20 ms sample interval);
  a child that lives longer before denying could be attributed. Best-effort.
- Defect 3 is unfixed at the tested tip; the signal-death path was exercised, the
  code-exit path was not (it is covered by the `exitCode !== null` guard).

## 12. Real-preamble validation + Defect 3 fix (`d198c4d`)

Candidate `d198c4d` adds the Defect 3 fix (shared `sandboxStreamExited` =
`exitCode !== null || signalCode !== null`, applied to both the startup and
main-loop stream guards; the main-loop guard now also reports failure if the
stream dies during drain). A later `40863c0` is test-only; production is `d198c4d`.
Rebuilt locally and driven through **temporary `start.sh` / `resume.sh` fixtures
that embed the REAL `sandboxDenialScriptPreamble` verbatim** (with `AGENT_LOG`
exported, a no-op `cleanup_sandbox_proxy`, and the candidate `ib` resolved through
a temporary `PATH` shim), plus the real gate helper and generated floor. Owner =
the `bash` fixture process; no dashboard/watchdog.

### Collector/stream topology (correcting §11)

Each collector spawns its **own** `/usr/bin/log stream` (one per collector);
every fixture collector was observed with exactly one log-stream child. Two
concurrent launches therefore run **two independent collectors, each with its own
stream**, both consuming the same system log. Isolation comes from each collector
attributing only its own registered root-tree — **not** from a shared stream (the
§11 "shared log stream" phrasing was imprecise and is corrected here).

### Results (real preamble)

| Axis | Result |
|---|---|
| `start.sh` verbatim preamble, root builtin read+write | **Attributed** (2 `[Sandbox]` records); enforced (EPERM, no file); collector cleaned its own dir |
| `resume.sh` verbatim preamble | Same as start (helpers are identical) — attributed, enforced, cleaned |
| Replacement / concurrent (two verbatim preambles) | **Isolated** — each `agent.log` only its own denials; both dirs removed; no cross-attribution |
| Log-stream SIGKILL (Defect 3 fix) | Collector emits `[SandboxCollector] ERROR: log stream stopped unexpectedly (exit=null, signal=SIGKILL)` and exits 1; supervisor then logs `collector exited 1`; kernel still denies read+write; collector `finally` runs so **no residual** dir/stream |
| Collector SIGKILL (supervisor visibility) | Shell supervisor logs `[SandboxCollector] ERROR: … collector exited 137` and touches `failed`; kernel still denies read+write |

### Collector-SIGKILL — observed unresolved cleanup limitation

SIGKILL bypasses the collector's `finally`, so — unlike the log-stream-SIGKILL
case — cleanup does not run. This subsection reports what was **observed**; whether
these residual effects are acceptable is a decision for Adam / the manager, not a
conclusion of this report:

- **Residual launch dir**: the launch directory persists with
  `ready, root-ready, collector-lock, stop, identity.json, failed, root-request`.
  The shell supervisor performs **no** numeric-PID cleanup; its EXIT trap writes
  `stop` but nothing removes the directory (observed).
- **Orphaned log-stream child**: the collector's `/usr/bin/log stream` child was
  still alive after the collector was SIGKILLed (reparented, since `finally`'s
  `stream.kill()` was bypassed). The supervisor reports failure but does not reap
  the child. This is an **observed, unresolved** cleanup gap for the collector-
  SIGKILL path; it is left for the owners to judge and, if desired, address.
- In this test the orphan was cleaned only by matching the **captured (pid,
  birth)** identity recorded before the kill (never pid alone), and no unrelated
  processes were signalled.

Scope: these residual/orphan effects are specific to an external SIGKILL of the
collector process; a stream failure (log-stream SIGKILL) still routes through the
collector's `finally`, leaving no residual. Both failure modes remain **visible**
in `agent.log` (and therefore in the DENIALS pane, §11) with kernel enforcement
intact.

### Remaining limits (unchanged)

Not tested with the real `claude`/`codex`/`agy` CLIs or the per-agent proxy
(synthetic sandboxed offenders only); single host / single boot; no real PID-reuse
exercised (birth identity guards it in-algorithm); the immediate-child drop
boundary is timing-dependent. The `start.sh`/`resume.sh` fixtures here embed the
real preamble/gate but are still minimized harnesses (no proxy, no real CLI), and
the surrounding production `start.sh`/`resume.sh` bodies were not executed whole.

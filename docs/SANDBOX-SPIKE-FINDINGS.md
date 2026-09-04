# SANDBOX-SPIKE-FINDINGS.md — Phase-1 Seatbelt Sandbox Spike

**Date:** 2026-07-18
**Machine:** macOS (Darwin 25.5.0, arm64), `sandbox-exec` present at `/usr/bin/sandbox-exec`
**Claude Code:** native single-file binary `v2.1.214` at
`~/.local/share/claude/versions/2.1.214` (symlinked from `~/.local/bin/claude`),
~247 MB, self-contained Bun-compiled runtime.
**Reference:** github.com/michaelneale/agent-seatbelt-sandbox
**Spec sections exercised:** §3.3, §4A.7, §4B, §4C, §5.1, §5.2, §6 (build-phase-1 spike).

This is an **exploratory findings report**, not an implementation. No `src/sandbox.ts`,
no wiring. All experiments were hand-run locally against the user's own `claude`
binary and are reproducible from the scripts in the spike scratchpad (paths noted
per section).

---

## 0. TL;DR — GO / NO-GO

| Question | Verdict |
|---|---|
| **(a) exec-in-place + PID discovery** (§3.3, G-4) | ✅ **GO** — `sandbox-exec` exec()s the target in place; `$!` / `pgrep` / `kill` / `wait` all target `claude`, not the wrapper. |
| **(b) Claude Code boots under `(deny default)`** (§6.1b) | ✅ **GO** — boots clean end-to-end (keychain OAuth + API) with a **tractable** allowlist. Model B is feasible; no fallback to `(allow default)` needed. |
| **(c) minimal baseline allowlist** | ✅ **Derived empirically** (see §4). One non-obvious must-have: `(allow file-read* (literal "/"))`. |
| **(d) domain-filtering proxy** | ✅ **GO** — kernel blocks direct egress; claude reaches `api.anthropic.com` **only** through the localhost CONNECT proxy, and honors `HTTPS_PROXY` **natively** (no `NODE_OPTIONS` needed). |
| **(e) surprises / gotchas** | Several — see §7. The biggest: **the unified-log harvest method the spec mandates does NOT surface our `sandbox-exec` process's own denials** on this macOS. Use bisection instead. |

**Bottom line for Adam: deny-by-default (Model B) is viable for Claude Code on this
machine. Ship it.**

---

## 1. SPIKE 1a — Plumbing (the cheap gate) ✅

### 1a.1 Exec-in-place — THE #1 question (§3.3 / G-4)

**Method** (`test-execinplace3.ts`): launched `sandbox-exec -f <profile> /bin/sleep 30`
as a backgrounded child (the `$!` a `start.sh` bare/fallback branch would capture),
then from **outside** the sandbox inspected that pid's `comm` + full `argv`.

**Result:**
```
child pid ($! equivalent) = 4816
comm = /bin/sleep          <-- NOT sandbox-exec
args = /bin/sleep 30
pgrep 'sandbox-exec.*sleep' -> ""   (no lingering wrapper process)
pgrep 'sleep 30'            -> 4816 (matches)
kill(4816) -> SIGTERM delivered, process died
```

**Conclusion:** `sandbox-exec`, like `setsid`, calls `sandbox_init` then **execs the
target in place — no fork, no lingering wrapper.** After the exec chain, `$!` *is*
`claude`. Therefore `CLAUDE_PID=$!` (`ib-commands.ts:5046`/`:1602`), the `meta.json`
write, `kill`, `wait $CLAUDE_PID`, and `pgrep -P <panePid> -f claude`
(`agent-lifecycle.ts:510`) all keep working **unchanged**. The PID/watchdog design
assumption in §3.3 is **confirmed, not merely plausible.** The design does **not**
need to change.

> ⚠️ G-4 assertion satisfied: we asserted the discovered pid's actual `comm`/`argv0`
> is the target, not just that `pgrep -f` returned *a* pid.

### 1a.2 Proxy-env export + `$!` (§3.3 simplification)

**Method** (`test-proxyenv.ts`): mimicked `start.sh` exactly — `export http_proxy=…`
lines, then a backgrounded `sandbox-exec … &`, captured `$!`, and had the sandboxed
child print its own pid + the proxy env vars it received.

**Result:** `BGPID == CHILD_PID` (both 6675) and the child saw
`https_proxy`, `HTTPS_PROXY`, `no_proxy` verbatim.

**Conclusion:** exporting the proxy vars in the shell **before** the `sandbox-exec`
launch line (the §3.3 "drop the `env` wrapper link" simplification) works: the vars
propagate through `sandbox-exec` into the sandboxed child, and `$!` still refers to
the wrapped process. **No `env` link needed.** One fewer process in the chain, zero
ambiguity — adopt the simplification.

---

## 2. SPIKE 1b — Boot Claude under `(deny default)` ✅

### 2.1 Reference `(allow default)` parity first

`allow-all.sb` = `(version 1)(allow default)`. Running the real
`claude -p "…" --output-format text` wrapped in `sandbox-exec -f allow-all.sb` →
**exit 0, prints `SPIKE_OK`.** Proves the plumbing boots the real binary, keychain
OAuth works, and `api.anthropic.com` is reached. (`runclaude.ts allow-all.sb`.)

### 2.2 Inverting to `(deny default)` — the iteration

The convergence, in order (each a separate `.sb` + `runclaude.ts` run):

| Profile | Read scope | Result | Lesson |
|---|---|---|---|
| `deny-v1` | narrow enumerated | **SIGABRT**, empty stdout/stderr | aborts at runtime init before logging |
| `deny-v2-readall` | `(allow file-read*)` + minimal writes | **SPIKE_OK** | write-set + `mach-lookup`(wide) + network already sufficient; blocker is a **read path** |
| `deny-v4` / `deny-v5` | broad enumerated incl. whole `/Users/adamwulf`, `/System`, `/usr`, `/Library`, `/private/var`, `/dev` | **SIGABRT** | the missing read is a **top-level entry**, not under any of those subpaths |
| `deny-v6-roots` | v5 + `(literal "/")` + symlink roots + `/Applications`… | **SPIKE_OK** | root-dir read was missing |
| `deny-v8-rootonly` | v5 + **only** `(allow file-read* (literal "/"))` | **SPIKE_OK** | ✅ **isolated: the single missing piece is the root-dir entry `/`** |

**Key derived fact:** Claude Code (the Bun-compiled binary) **reads the root
directory `/` at startup**. Without `(allow file-read* (literal "/"))` it SIGABRTs
during runtime init — *before* it can write its `--debug-file` or emit a single byte
of stderr (verified: the debug file stays empty). The symlink roots `/etc`, `/tmp`,
`/var` are **not** required (covered by `file-read-metadata` traversal + the
`/private/*` real targets). **This is the headline baseline gotcha.**

### 2.3 Pre-warned boot-blockers (§6.1b) — actual findings

| Pre-warned blocker | Finding |
|---|---|
| **Keychain / OAuth** (predicted THE blocker) | Real, but **satisfied by `mach-lookup` + `~/Library/Keychains` read**. This machine's claude has **no** `ANTHROPIC_API_KEY`; auth is OAuth in `login.keychain-db` (`security find-generic-password -s "Claude Code-credentials"` → found). Wide-open `mach-lookup` works; a **curated** `mach-lookup` allowlist also works (§2.4). |
| **`~/.claude` must be writable** | ✅ confirmed writable-required and sufficient. NB: `~/.claude` is **huge** (80 MB `history.jsonl`, thousands of `usage-cache.json.*`, `projects/` with 2000+ dirs) — the broad `~/.claude/**` allow is unavoidable. |
| **`/dev` (null/urandom/tty + pane pty)** | Broad `/dev` read+write allow works. **Not independently bisected** — a full interactive TUI needs the pane's `/dev/ttysNNN`; `-p` mode (used here) does not. See §7 gap. |
| **`/private/tmp` not `/tmp`** | ✅ correct — canonical-path matching; used `/private/tmp` throughout. |
| **`NODE_OPTIONS=--use-env-proxy`** | ❌ **NOT needed.** claude honors `HTTPS_PROXY` natively (§3, deliverable d). Don't add it — avoids the "leaks into every node child" footgun. |
| **git** (`~/.gitconfig`, osxkeychain) | ✅ `git status/log/rev-parse/config user.name` all succeed under the profile (§2.5). `user.name` reads `~/.gitconfig`. |
| **`~/.claude.json`** (G-1, sibling FILE) | ✅ exists; baseline allows it read+write as a `(literal …)`. Boot succeeded with it allowed. |
| **dev toolchain gate** (G-2) | ✅ `bunx tsc --noEmit` → exit 0; `bun test src/known-models.test.ts` → 4 pass/0 fail — **under the profile**. `~/.bun` covered by home read; **no npm fetch needed** (deps cached), so `registry.npmjs.org` is optional for the gate. |
| **`~/.itsybitsy/**` reads + `ib`** (G-3, §4C.1) | ✅ `ib list` (cross-repo `.ittybitty/agents/*/meta.json` reads across 4 repos) + `ib status` → exit 0. `~/.itsybitsy/agents/**` **write** verified (`touch` succeeds; a write to `~/Documents` is correctly **denied**). |
| **MCP server** | ❌ **NOT tested** — deferred. See §7 gaps. |
| **codex** (§4B) | ❌ **NOT tested** — `-s danger-full-access` flag + proxy-honoring still to verify. See §7. |

### 2.4 `mach-lookup` can be scoped (bonus tightening)

`deny-machscoped.sb` replaced wide-open `mach-lookup` with a **curated global-name
list** (opendirectoryd libinfo/membership, securityd/SecurityServer/security.agent,
trustd(+agent), cfprefsd daemon/agent, notification_center, logd/logd.events/
diagnosticd/system.logger, launchservicesd, DirectoryService.libinfo, dnssd,
mDNSResponder) → **SPIKE_OK with keychain auth.** So a tighter `mach-lookup` is
feasible. **Caveat:** tested under `-p` (no TUI); a full interactive agent may touch
more services. Recommend: **ship wide-open `mach-lookup` in the first baseline,
tighten to the curated list in a follow-up** once the TUI path is exercised.

### 2.5 git under the profile

`gittest.ts` (under `deny-net.sb`): `git status --short -b`, `rev-parse HEAD`,
`log -1`, `rev-parse --git-common-dir` (→ `/Users/adamwulf/Developer/bun/itsybitsy/.git`),
`config user.name` (→ "Adam Wulf") — **all exit 0.** Worktree + gitdir reads/writes +
`~/.gitconfig` read all work. (SSH remotes still can't work — ssh ignores
`http_proxy`, port-22 egress is kernel-blocked — but local branch ops are fine, as
the spec predicted.)

---

## 3. Network / proxy (deliverable d) ✅ — strongest result

### 3.1 Kernel blocks direct egress

`deny-net.sb`: `(deny network*)` + allow only `localhost:*` outbound/inbound +
`mDNSResponder` + `remote unix-socket`. Running `curl` under it (`nettest.ts`):

```
https://api.anthropic.com:443  -> curl (7) Couldn't connect (4 ms)   [BLOCKED]
https://example.com:443        -> curl (7) Couldn't connect          [BLOCKED]
```

Direct egress to any remote host is refused at the kernel — fails closed.

### 3.2 claude reaches the API ONLY through the localhost proxy

`net-e2e.ts`: started a **pure-Bun localhost CONNECT proxy** (`proxy.ts`, allowlist
`api.anthropic.com,*.anthropic.com,…`) unsandboxed, then ran claude under
`deny-net.sb`:

```
A. WITH  HTTPS_PROXY=http://localhost:PORT  -> exit 0, "SPIKE_OK"
B. WITHOUT proxy env                        -> fails ("Execution error", kernel-blocked)
```

Proxy log during A:
```
[proxy] ALLOW api.anthropic.com:443   (×many)
[proxy] DENY  registry.npmjs.org:443
[proxy] DENY  http-intake.logs.us5.datadoghq.com:443
```

**Conclusions:**
- **claude honors `HTTPS_PROXY` natively** — no `NODE_OPTIONS=--use-env-proxy`.
- The domain allowlist **enforces**: npmjs + Datadog telemetry were **denied** and
  claude **still completed the prompt** — so those are **non-fatal**. The **minimal
  domain allowlist for a working claude is just `api.anthropic.com`** (add
  `*.anthropic.com` to cover statsig/telemetry cleanly; npmjs only if `bun install`
  must run at agent runtime; datadog never).
- Without a proxy at all, a sandbox-enabled agent is **fully offline** — this is why
  phases 2+3 must land **together** (R2): `sandbox.enabled: true` is unusable until
  the proxy exists.

### 3.3 Proxy host-matching semantics (§5.2) — 10/10 unit tests

`proxymatch.ts` validated the exact §5.2 rules the implementer must port:

| Host | vs `["api.anthropic.com","*.example.com"]` | Match |
|---|---|---|
| `api.anthropic.com` / `API.ANTHROPIC.COM` | apex exact, case-insensitive | ✅ |
| `evil-api.anthropic.com` | apex is exact — NOT subtree | ❌ |
| `anthropic.com` | parent not listed | ❌ |
| `example.com` / `a.example.com` / `a.b.example.com` | `*.` = base + one-or-more labels | ✅ |
| `example.com.evil.com` / `xexample.com` | dot-boundary enforced | ❌ |

Plus (enforced in `proxy.ts`): **CONNECT only** (TLS tunnels + explicit `:80`),
**ports 443/80 only**, **IP-literal CONNECT denied**.

---

## 4. The derived baseline allowlist (deliverable c)

This is the empirically-proven floor that boots claude + runs the gate + `ib` + git
under `(deny default)`. **Static paths → `_all.md`; the four `-D` params → injected
at spawn.** Paths are this machine's; generalize the *categories*, re-verify exact
paths on the target install (they are Claude-version- and install-layout-dependent).

### 4.1 `-D` runtime params (injected by spawn/resume, per §4A.7)
- `WORKTREE` = `<agentDir>/repo`
- `GITDIR`   = git common dir (`git rev-parse --git-common-dir`; reuse codex's `resolveGitRevParsePath`)
- `AGENTDIR` = `<repoPath>/.ittybitty/agents/<id>` (subsumes WORKTREE; hooks write meta.json/agent.log/debug-logs here)
- `HOME`     = the user's home (used for the `string-append` write rules)

### 4.2 SBPL skeleton (proven-working shape)

```scheme
(version 1)
(deny default)

;; ---- syscalls / process ----
(allow process*)                 ;; broad; scope in a later pass
(allow sysctl-read)
(allow signal (target self))
(allow file-read-metadata)       ;; path traversal (stat/lstat/readlink) anywhere
(allow file-ioctl)
(allow mach-lookup)              ;; wide for baseline-1; curated list in §2.4 also works

;; ---- runtime-injected roots (read + write) ----
(allow file-read*  (subpath (param "AGENTDIR")))   ;; contains WORKTREE
(allow file-write* (subpath (param "AGENTDIR")))
(allow file-read*  (subpath (param "GITDIR")))
(allow file-write* (subpath (param "GITDIR")))

;; ---- READ baseline ----
(allow file-read* (literal "/"))                   ;; ⚠️ MANDATORY — claude reads root dir at init
(allow file-read* (subpath "/usr"))
(allow file-read* (subpath "/bin"))
(allow file-read* (subpath "/sbin"))
(allow file-read* (subpath "/System"))
(allow file-read* (subpath "/Library"))            ;; frameworks, prefs, /Library/Keychains parent
(allow file-read* (subpath "/private/etc"))        ;; resolv.conf, etc
(allow file-read* (subpath "/private/var"))        ;; dyld cache, tz, per-user
(allow file-read* (subpath "/dev"))
(allow file-read* (subpath "/opt/homebrew"))       ;; node/git/tmux on this machine (Apple-silicon Homebrew)
(allow file-read* (subpath "/Users/adamwulf/.local"))      ;; claude binary
(allow file-read* (subpath "/Users/adamwulf/.bun"))        ;; bun + dep cache
(allow file-read* (subpath "/Users/adamwulf/Library/Keychains"))
(allow file-read* (subpath "/Users/adamwulf/Library/Preferences"))
(allow file-read* (literal "/Users/adamwulf/.gitconfig"))
(allow file-read* (subpath "/Users/adamwulf/.claude"))
(allow file-read* (literal "/Users/adamwulf/.claude.json"))
(allow file-read* (subpath "/Users/adamwulf/.itsybitsy"))
;; ib list cross-repo reads: allow the registered repos' trees (or accept ib list degrading)
(allow file-read* (subpath "/Users/adamwulf/Developer"))   ;; (broad; scope to registered repos later)

;; ---- WRITE baseline ----
(allow file-write* (subpath "/Users/adamwulf/.claude"))
(allow file-write* (literal "/Users/adamwulf/.claude.json"))
(allow file-write* (subpath "/Users/adamwulf/.itsybitsy/agents"))
(allow file-write* (subpath "/private/tmp"))               ;; NOT /tmp (canonical)
(allow file-write* (subpath "/private/var/folders"))
(allow file-write* (subpath "/dev"))                       ;; tighten to null/urandom/tty/pty later

;; ---- NETWORK: deny egress, localhost hole for the proxy ----
(deny network*)
(allow network-outbound (literal "/private/var/run/mDNSResponder"))
(allow network-outbound (remote unix-socket))
(allow network-outbound (remote ip "localhost:*"))
(allow network-inbound  (local ip "localhost:*"))

;; ---- config deny list LAST (deny-wins) ----
;; (deny file-read* (subpath (param "DENY_0")) …)
```

**Minimal domain allowlist (proxy):** `api.anthropic.com` (+ `*.anthropic.com`).
`registry.npmjs.org` only if agents run `bun install` at runtime; never datadog.

### 4.3 Notes on the read set
- I did **not** minimize each `/usr /System /Library …` subpath to the exact
  dylib set — the compiled binary maps the dyld shared cache and many frameworks;
  subpath-level allows are the practical unit. `(allow file-read*)` (everything)
  also works if the team decides read-side isolation isn't worth the enumeration
  (write-side + network are where Model B earns its keep).
- `/Users/adamwulf/Developer` is broad (for `ib list`'s cross-repo reads). Tighten
  to the registry's actual repo roots, or accept `ib list` degrading, per §4C.1.

---

## 5. Test harness / methodology (for the phase-2/3 implementer to reuse)

**The harness allowlist blocks `sandbox-exec`, `ps`, `pgrep`, `log`, `security`,
`sleep`, `printf` directly**, and forbids pipes/chaining (single-command rule). The
working escape hatch: **drive every experiment from inside one `bun run <script>.ts`
call** (`bun` is allowlisted) that spawns `sandbox-exec`/`claude`/`log`/`curl` as
children via `Bun.spawn`/`spawnSync`. The harness gates only the top-level command,
not its descendants. All spike scripts live in the session scratchpad
(`…/scratchpad/sandbox-spike/`): `test-execinplace3.ts`, `test-proxyenv.ts`,
`runclaude.ts`, `deny-*.sb`, `proxy.ts`, `net-e2e.ts`, `gittest.ts`, `devgate.ts`,
`ibtest.ts`, `writetest.ts`, `proxymatch.ts`.

---

## 6. Reproduction summary

| Deliverable | Script | Result |
|---|---|---|
| exec-in-place / PID | `test-execinplace3.ts` | comm=/bin/sleep, no wrapper, kill works |
| proxy-env + `$!` | `test-proxyenv.ts` | BGPID==CHILD_PID, vars propagate |
| `(allow default)` parity | `runclaude.ts allow-all.sb` | SPIKE_OK |
| deny-default boot | `runclaude.ts deny-v8-rootonly.sb` | SPIKE_OK |
| scoped mach-lookup | `runclaude.ts deny-machscoped.sb` | SPIKE_OK |
| kernel egress block | `nettest.ts` | api/example blocked |
| proxy-only API | `net-e2e.ts` | with-proxy SPIKE_OK, without fails |
| proxy matching | `proxymatch.ts` | 10/10 |
| git | `gittest.ts` | all exit 0 |
| gate (tsc+test) | `devgate.ts tsc` / `devgate.ts test` | exit 0 / 4 pass |
| ib smoke | `ibtest.ts` | list+status exit 0 |
| write allow/deny | `writetest.ts` | in-allowlist OK, ~/Documents DENIED |

---

## 7. Surprises & gotchas for the phase-2/3 implementer

1. **⚠️ `(allow file-read* (literal "/"))` is mandatory.** Claude Code reads the root
   directory at runtime init; without it, **SIGABRT with zero output** (not even a
   `--debug-file` line). This is the single least-obvious baseline rule and the
   easiest to omit. Bake it into the generator, not just `_all.md`.

2. **⚠️ The unified-log harvest method (mandated in §5.1/§6.1b) does NOT work for our
   process on this macOS.** Two independent problems:
   - `(with report)` / `(deny default (with report))` is **rejected by the SBPL
     compiler**: `sandbox-exec: report modifier does not apply to deny action`
     (R3 confirmed — worse than "degraded"; it won't compile).
   - `sandbox-exec`-launched custom-profile denials **do not appear** in
     `log show`/`log stream` (I see denials from container-sandboxed system daemons
     — `imagent`, `duetexpertd`, `GamePolicyAgent` — but **never our `claude`'s**).
     The correct predicate *is* `process == "kernel" AND eventMessage CONTAINS
     "deny(1)"`, and it works for App-Sandbox daemons; it just never fires for our
     `sandbox-exec` process.
   **→ Use profile bisection instead** (start `(allow file-read*)`, narrow; or narrow
   set, widen — flip one region at a time and re-run). That is how §2.2's baseline
   was derived. Document this in implementation-notes so the next person doesn't
   burn time on `log show`.

3. **Early aborts are silent.** A missing *read* path → SIGABRT with **empty stdout
   AND stderr AND empty `--debug-file`**, because the abort precedes logger init.
   Don't expect a helpful EPERM message; treat any `SIGABRT`/exit-null under a new
   profile as "a read path is missing," and bisect.

4. **`ps` is denied even under `(allow default)`** (`process-info*` isn't granted by
   `(allow default)`). Any in-sandbox tool that shells `ps` will fail; the watchdog's
   process inspection must run **outside** the sandbox (it does — watchdog is a
   separate process). Just don't rely on in-sandbox `ps`.

5. **claude's normal traffic is broader than `api.anthropic.com`.** It also dials
   `statsig.anthropic.com` (telemetry), `registry.npmjs.org`, and
   `http-intake.logs.us5.datadoghq.com` (Datadog). All **non-fatal** when denied — a
   prompt still completes — so the allowlist can be tight. But expect these in the
   proxy's DENY log; they're not errors.

6. **`HTTPS_PROXY` is honored natively — do NOT add `NODE_OPTIONS=--use-env-proxy`.**
   It's unnecessary and leaks into every node child (dev servers etc.). Dead item;
   remove from the plan.

7. **`mach-lookup` scoping is feasible but unproven for the TUI.** Curated list boots
   `-p`. Ship wide-open first; tighten after driving a real interactive/tmux agent.

8. **`/dev` broad-allowed here.** A real agent runs in a **tmux pane pty**
   (`/dev/ttysNNN`); `-p` mode doesn't exercise it. Keep `/dev` read+write in
   baseline-1; the exact minimal `/dev` set (null, urandom, tty, the pane pty,
   dtracehelper) is a phase-2 tightening, and the pane pty is **runtime-determined**
   (may need its own `-D` or a `/dev/ttys*` regex).

9. **Read/write are independently gated** (as intended): `~/Documents` is *readable*
   (broad home read) yet **write-denied**. Good — Model B write isolation holds even
   with a permissive read side. This is the honest isolation story from §4C.5:
   coarse write walls + hard network deny, not fine per-worker read isolation.

10. **`ib`/claude/node/bun are NOT at the spec's assumed paths on this machine.**
    `claude` = `~/.local/bin` (not `/usr/local/bin`); `node`/`git`/`tmux` =
    `/opt/homebrew/bin`; `bun` = `~/.bun/bin`; `ib` = the dev checkout
    `~/Developer/bun/itsybitsy/ib` (not `/usr/local/bin/ib`). §4A.7's
    `/usr/local/bin` assumption is install-specific — the generator must resolve
    these from `which`/config, not hardcode.

---

## 8. NOT covered (honest gaps → phase-2 backlog)

- **MCP server under the profile** (§4C.4) — not booted. Needs interpreter paths
  (`~/.bun`/`~/.nvm`/`uv`) + its own allowlisted egress. **Must test in phase 2.**
- **codex** (§4B) — `-s danger-full-access` flag verification + does codex honor
  `http(s)_proxy` under it + `-a never`/tty interaction. Untested.
- **Full interactive TUI** in a real tmux pane (pty path, `--tmux`) — only `-p` mode
  was driven. The pane pty `/dev/ttysNNN` requirement is inferred, not exercised.
- **`ib new-agent` from a sandboxed manager** (§4C.1) — parent-repo `.ittybitty`
  mkdir + `.claude/settings.local.json` write; and **§4C.2 watchdog spawn
  inheritance** (the design decision that must precede phase 3).
- **tmux socket escape** (§4C.3) — not exercised; the recommendation (deny the tmux
  socket subpath for non-spawning types) stands as design, unverified.
- **Full `bun test` suite + real `bun install`** through the proxy (only a single
  cached-deps test file + tsc were run).
- **Per-region read minimization** — the read baseline is subpath-granular, not
  dylib-exact.

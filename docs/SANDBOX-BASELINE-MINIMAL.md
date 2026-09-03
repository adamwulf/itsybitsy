# SANDBOX-BASELINE-MINIMAL.md — Phase-1.5 Minimal Baseline (verified by bisection)

**Date:** 2026-07-18
**Machine:** macOS (Darwin 25.5.0, arm64), `sandbox-exec` at `/usr/bin/sandbox-exec`
**Claude Code:** native single-file binary `~/.local/bin/claude` (Bun-compiled).
**Method:** every rule below was flipped **one at a time** and re-run against the real
`claude` binary (deny-default, Model B). This refines `docs/SANDBOX-SPIKE-FINDINGS.md`
(phase-1) which derived the allowlist in ONE pass; here every entry is **minimized and
verified**, per Adam's "test everything, assume nothing."

All experiments are reproducible from the scripts in the phase-1.5 scratchpad
(`verify/`): `run.ts`, `gen.ts`, `matrix.ts`, `machmin.ts`, `readshrink.ts`,
`homefinal.ts`, `netbisect.ts`, `e2e2.ts`, `minimal.sb`, `minimal-plus.sb`, `proxy.ts`,
plus the `RESULTS.md` log. The harness rule (one top-level command per call) is honored
by driving each experiment from inside one `bun run <script>.ts` that spawns
`sandbox-exec`/`claude`/`curl` as children.

> **Scope caveat, stated up front:** the minimizations were driven with `claude -p`
> (headless) + the dev gate + `ib`/git — NOT a full interactive tmux TUI, MCP, or
> codex. Where a `-p`-droppable rule is still needed by the TUI/gate/git, it is called
> out and **kept**. The TUI/MCP/codex tightening is phase-2 (see §7).

> **A3 update (2026-09-02) — the shipped floor lives in `docs/agent-types/_all.md`.**
> This document is the historical bisection record and is otherwise unchanged.
> The floor actually shipped since then tightened §(c)/(e) further: `allowRead`
> **drops `/` and `~`** (the root listing moved to the `rawAllow` line
> `(allow file-read-data (literal "/"))` of §(a); the `bunx tsc` broad-home cost
> of §(c) is now paid per-type by adding `~`), `allowWrite` gained the
> `~/.itsybitsy` team floor (`teams`, `teams.json`, `teams.json.tmp`,
> `.teams.lock`), and the runtime `-D` roots of §(f) are keyed on
> `canSpawnChildren` (REPOAGENTS write for spawners, a new PARENTCLAUDE write
> root, and a TMUXSOCK deny for non-spawners). See SPEC-SANDBOX.md §4A.7, §4A.8,
> §4C.1, §4C.3 and the LIVE tests in `src/sandbox.test.ts`. The §(d) exit-143
> "fully offline" proof is the criterion the shipped LIVE boot gate uses.

---

## (a) THE `/` VERDICT — mandatory, path-irreducible; op-class narrowable

**`(allow file-read* (literal "/"))` IS mandatory. It cannot be replaced by narrower
top-level entries. The ONLY tightening is the op-class: `file-read-data` suffices.**

Evidence (V1):

| Test | Result |
|---|---|
| Remove only `(literal "/")`, everything else broad | **SIGABRT, zero output** (no stdout/stderr/debug-file) |
| Replace with `(allow file-read-data (literal "/"))` | ✅ **boots** (op-class tightened) |
| Grant EVERY top-level child (`/usr`,`/bin`,`/System`,… as literals) but NOT `/` | **SIGABRT** |
| `node -e` probe of `/` under the no-root profile | node itself SIGABRTs at init — **not claude-specific** |
| Same probe under baseline | `stat /` OK, `readdir /` OK (21 entries), `open(O_DIRECTORY)` OK |

**Why it's irreducible (not just re-asserted):** it is the **Bun/Node runtime**, not
claude application logic, that reads the **root-directory node `/` itself** (a
`readdir`/`opendir` of `/`) during process init — plain `node` SIGABRTs identically.
`file-read-metadata` is granted unbounded yet the process still aborts, so the failing
operation is a **directory-DATA read of the `/` node**, not a `stat` and not a read of
any child. Because granting all top-level children (without `/`) still aborts, no set of
child-allows substitutes for the root node. `(literal "/")` is already the narrowest
**path** form — it matches exactly the `/` node, not a subtree. The only lever left is the
**operation class**, and `file-read-data` is enough.

**→ `_all.md` entry:** `allowRead: ["/"]` compiles to `(allow file-read* (subpath "/"))`
in the current generator model, which is broader than needed (it grants the whole tree).
To get the tightest form the generator would need to special-case root as
`(allow file-read-data (literal "/"))`. **Recommendation:** since Adam's rule is zero
baked-in logic, keep `"/"` in `allowRead` for now (correct, boots) and note the
op-class/`literal` tightening as an optional generator refinement (it changes `/` from
"whole tree readable" to "root-dir listing only" — a real isolation win, but it is the
one entry that can't be expressed in the plain path grammar).

---

## (b) MINIMAL SYSCALL SET (rawAllow)

Removed each spike syscall one at a time (V2):

| Syscall | Verdict | Failure when removed |
|---|---|---|
| `(allow process*)` | **MANDATORY** | `execvp()` Operation not permitted — can't even exec claude |
| `(allow sysctl-read)` | **MANDATORY** | SIGKILL |
| `(allow mach-lookup …)` | **MANDATORY** | exit 1 (no keychain/OAuth) |
| `(allow file-read-metadata)` | **MANDATORY** | `EPERM mkdir /tmp/claude-501` — needs it to resolve `/tmp`→`/private/tmp` + stat path components |
| `(allow signal (target self))` | **DROP** ✅ | boots fine without it (`-p`) |
| `(allow file-ioctl)` | **DROP** ✅ | boots fine without it (`-p`) |

Both drops confirmed **jointly** (dropping `signal`+`ioctl` together still boots + runs
the full gate, V5). `signal` is not needed in-sandbox because the watchdog `kill`s claude
from **outside** the sandbox (separate process).

### `mach-lookup` — minimized, with an honest caveat
Greedy joint-shrink (machmin.ts) collapses the curated 18-name list all the way to a
**single service, `com.apple.SecurityServer`**, and claude still boots + does keychain
OAuth under `-p`. **BUT** that 1-service floor was measured under `-p` + `(allow
network*)` (DNS services fell out because the proxy does DNS). A full **interactive TUI**
(not exercised) may touch `cfprefsd`/`launchservicesd`/`notification_center`/`trustd`/
`logd`. **Recommendation: ship the curated-18 list** (proven, TUI-safe margin, matches
the spike); tighten toward `SecurityServer` only after a real tmux TUI agent is driven
under the profile.

### `file-read-metadata` scoping
Scopeable to a ~13-root traversal set (readmeta-scoped.ts: unbounded ✅, scoped ✅,
none ❌) but low-value (metadata = existence/size/mtime only; the scoped list already
covers every root). **Keep unbounded** as the practical unit.

**Minimal rawAllow syscall lines:** `process*`, `sysctl-read`, `mach-lookup` (curated-18),
`file-read-metadata`.

---

## (c) MINIMAL READ / WRITE PATH SET

### Reads (V3)
`-p`-boot joint-minimal = `{/usr, /System, /private/var, /Users/adamwulf}`. But
`-p`-droppable ≠ safe-to-drop — these are needed by git / the dev gate / the TUI even
though a bare `-p` boot doesn't touch them, so they are **kept**:

| Subpath | `-p` boot | Kept because |
|---|---|---|
| `/usr` | REQUIRED | — |
| `/System` | REQUIRED | — |
| `/private/var` | REQUIRED | dyld cache, per-user temp, tz |
| `/opt/homebrew` | droppable | node/git/tmux live here (gate, git, TUI) |
| `/bin`, `/sbin` | droppable | shell tools the agent runs |
| `/private/etc` | droppable | `resolv.conf` (DNS once network is denied) |
| `/dev` | droppable | pane pty `/dev/ttysNNN` (TUI) |
| `/Library` | droppable | frameworks/prefs some paths hit |

**Home read — biggest isolation win (V3).** Whole `/Users/adamwulf` was only "required"
because the probe granted `file-write*` (not `file-read*`) on the `-D` roots, forcing
claude to read up the worktree's ancestor chain. **Adding `file-read*` on the injected
`AGENTDIR`/`GITDIR` roots (which the real feature injects anyway) narrows whole-home read
to 5 subpaths + 2 files** and still boots:

- subpaths: `~/.claude`, `~/.local`, `~/.bun`, `~/Library/Keychains`, `~/.itsybitsy`
- files: `~/.claude.json`, `~/.gitconfig`

This confirms spike §4.2's note that **the `-D` param roots must be read+write, not
write-only.**

> ⚠️ **Dev-gate exception (V5):** `bunx tsc --noEmit` for a package NOT installed in the
> worktree (no `node_modules`) needs **broad `~/` read** — extensively bisected, it is
> not `~/.bun`, not `~/.cache`, not `~/Library/*`, not the home-node literal, nor any
> single home subdir; only `(subpath "/Users/adamwulf")` fixes it (bun scans several home
> locations during package resolution). This is a **gate** need, NOT a claude-boot need
> (claude boots on the 5 dotdirs). Mitigation: worktrees that are `bun install`ed have
> `node_modules` and likely avoid it; otherwise `_all.md` grants `~/` read as the floor.
> **Not minimized below broad-home for the gate — stated honestly.**

`/usr`,`/System`,`/private/var` were **not** reduced to a dylib-exact set — the
Bun-compiled binary maps the dyld shared cache + many frameworks; subpath-granular is the
practical unit (matches spike §4.3). High-effort, low-value; not done.

### Writes
Minimal write set (all load-bearing or low-risk):
`~/.claude` (transcripts/history/statsig/todos), `~/.claude.json` (file), `~/.bun`
(bunx staging), `~/.itsybitsy/agents` (agent state), `/private/tmp`,
`/private/var/folders` (temp/caches), `/dev` (pty/null/urandom). Plus the injected
`WORKTREE`/`AGENTDIR`/`GITDIR`. `~/Documents` etc. correctly stay **write-denied**.

---

## (d) MINIMAL NETWORK BLOCK (rawAllow)

Bisected under `(deny network*)` + a variable set of localhost holes, proxy allowing
`api.anthropic.com,*.anthropic.com` (V4):

| Hole | Verdict |
|---|---|
| `(allow network-outbound (remote ip "localhost:*"))` | **MANDATORY** — claude→proxy CONNECT |
| `(allow network-outbound (literal "/private/var/run/mDNSResponder"))` | droppable* |
| `(allow network-outbound (remote unix-socket))` | droppable* |
| `(allow network-inbound (local ip "localhost:*"))` | droppable |

**Absolute minimal block = TWO lines:**
```
(deny network*)
(allow network-outbound (remote ip "localhost:*"))
```
`mDNSResponder`/`unix-socket` are droppable because **DNS happens at the proxy**
(unsandboxed) — claude sends `CONNECT api.anthropic.com:443` by hostname to
`localhost:PORT` and the proxy resolves it (confirmed by proxy log showing hostname
CONNECTs, never IP-literal from claude).

***Recommendation:** keep `mDNSResponder` + `unix-socket` as cheap safety margin — any
in-sandbox process that resolves DNS directly (a tool not honoring `http_proxy`) would
need mDNS. Drop only inbound-localhost.

✅ **Fail-closed proven:** with the holes present but NO `http(s)_proxy` env, claude is
fully offline (kernel blocks direct egress, exit 143) — never a silent direct-egress leak.

**Minimal domain allowlist (proxy, not the profile):** `api.anthropic.com` +
`*.anthropic.com`. Add `registry.npmjs.org` ONLY if agents run `bunx`/`bun install` that
must fetch at runtime (the phase-1.5 gate used a cached typescript, but `bunx` opened a
registry check — non-fatal when denied). Never datadog.

---

## (e) THE COMPLETE `_all.md` SANDBOX BLOCK (ready to paste)

Expressed in the **actual schema** (§4/§5.1): `allowRead`/`allowWrite`/`deny` = file
paths; `rawAllow` = raw SBPL (syscalls + network block); `domains` = proxy allowlist.
Paths are this machine's — generalize the categories and re-verify on the target install
(they are Claude-version / install-layout dependent; §5.1 gotcha 4).

```yaml
sandbox:
  enabled: true

  # ---- FILES: readable paths ----
  allowRead:
    - "/"                                  # MANDATORY root-dir read (V1). See note below.
    - "/usr"
    - "/System"
    - "/Library"
    - "/bin"
    - "/sbin"
    - "/opt/homebrew"                      # node / git / tmux (Apple-silicon Homebrew)
    - "/private/etc"                       # resolv.conf, terminfo
    - "/private/var"                       # dyld cache, per-user temp, tz
    - "/dev"                               # null / urandom / tty / pane pty
    - "~/.claude"                          # config + transcripts (also written)
    - "~/.claude.json"                     # oauth/account/trust (also written)
    - "~/.local"                           # claude binary
    - "~/.bun"                             # bun + dep cache
    - "~/.itsybitsy"                       # ib config / registry / agent-types
    - "~/.gitconfig"                       # user.name/email for commits
    - "~/Library/Keychains"                # OAuth credentials
    # ---- dev-gate pragmatic floor (see §c caveat): bunx for an uninstalled pkg needs
    # broad home read. Include ONLY if agents run `bunx`/`bun install` on worktrees that
    # are NOT `bun install`ed. If worktrees carry node_modules, DROP this line.
    - "~"

  # ---- FILES: writable paths ----
  allowWrite:
    - "~/.claude"
    - "~/.claude.json"
    - "~/.bun"                             # bunx staging
    - "~/.itsybitsy/agents"                # agent state (meta.json / agent.log / debug-logs)
    - "/private/tmp"                       # NOT /tmp — seatbelt matches canonical paths
    - "/private/var/folders"               # macOS per-user temp/caches
    - "/dev"

  # ---- FILES: deny holes (carved last, deny-wins). Tune per policy. ----
  deny:
    - "~/.ssh"
    - "~/.aws"
    - "**/.env"

  # ---- COMMANDS / SYSCALLS / NETWORK BLOCK: raw SBPL (every non-path hole visible) ----
  rawAllow:
    - "(allow process*)"
    - "(allow sysctl-read)"
    - "(allow file-read-metadata)"
    - "(allow mach-lookup (global-name \"com.apple.system.opendirectoryd.libinfo\") (global-name \"com.apple.system.opendirectoryd.membership\") (global-name \"com.apple.securityd\") (global-name \"com.apple.security.agent\") (global-name \"com.apple.SecurityServer\") (global-name \"com.apple.trustd\") (global-name \"com.apple.trustd.agent\") (global-name \"com.apple.system.notification_center\") (global-name \"com.apple.system.logger\") (global-name \"com.apple.diagnosticd\") (global-name \"com.apple.logd\") (global-name \"com.apple.logd.events\") (global-name \"com.apple.cfprefsd.daemon\") (global-name \"com.apple.cfprefsd.agent\") (global-name \"com.apple.coreservices.launchservicesd\") (global-name \"com.apple.system.DirectoryService.libinfo_v1\") (global-name \"com.apple.dnssd.service\") (global-name \"com.apple.mDNSResponder\"))"
    - "(deny network*)"
    - "(allow network-outbound (remote ip \"localhost:*\"))"
    - "(allow network-outbound (literal \"/private/var/run/mDNSResponder\"))"
    - "(allow network-outbound (remote unix-socket))"

  # ---- NETWORK: domain allowlist (per-agent proxy) ----
  domains:
    - "api.anthropic.com"
    - "*.anthropic.com"
    # - "registry.npmjs.org"               # ONLY if runtime bunx/bun install must fetch
```

**Notes:**
- `signal` and `file-ioctl` are **deliberately absent** from `rawAllow` (V2 proved both
  droppable). If a future TUI path needs `signal (target self)`, add it back as one line.
- The `(deny network*)` line inside `rawAllow` is emitted in the allow section; the
  localhost re-allow that follows it wins via SBPL last-match — exactly the reference
  pattern (§5.1). Config `deny` (file paths) is emitted **after** all of this, so it wins.
- `~` expands to the user's home. If the generator doesn't expand `~`, spell the paths
  absolutely (`/Users/<user>/…`) — the spike box is `/Users/adamwulf`.

---

## (f) RUNTIME-INJECTED `-D` PARAMS (must NOT be static in `_all.md`)

These don't exist until the worktree is created, so the spawn/resume script injects them
as Seatbelt `-D` params (like the reference passes `SECRETS_DIR`). The generator emits
rules that reference `(param "…")`:

| `-D` param | Value | Rules it backs |
|---|---|---|
| `AGENTDIR` | `<repoPath>/.ittybitty/agents/<id>` | `file-read* + file-write* (subpath (param "AGENTDIR"))` — **contains WORKTREE**; MANDATORY read+write (V3 fix) |
| `WORKTREE` | `<agentDir>/repo` | `file-write* (subpath (param "WORKTREE"))` (subsumed by AGENTDIR read) |
| `GITDIR` | `git rev-parse --git-common-dir` (reuse codex's `resolveGitRevParsePath`) | `file-read* + file-write* (subpath (param "GITDIR"))` — MANDATORY read+write |
| `REPOAGENTS` | `<repoPath>/.ittybitty/agents` (the parent-repo registry) | `file-read* (subpath (param "REPOAGENTS"))` — needed by **`ib status`** to resolve the agent ("Agent not found" without it; `ib list` works without it). NEW finding (V5). |
| `HOME` | user home | only if the generator needs it to build `~`-relative write rules |

> ⚠️ **`file-read*` on AGENTDIR + GITDIR is what lets whole-home read collapse to 5
> dotdirs.** Without it claude reads the worktree's `~/Developer/…` ancestor chain and you
> are forced back to broad-home. Inject them read+write, not write-only.

The **pane pty** (`/dev/ttysNNN`) is covered by the static broad `/dev` read+write for
now; a tighter per-agent `/dev/ttys*` rule (its own `-D` or a regex) is a phase-2
tightening — not exercised here (`-p` mode has no pane pty).

---

## §7. What was NOT minimized (honest gaps → phase-2)

1. **`/` op-class in the schema.** `allowRead: ["/"]` compiles to
   `(subpath "/")` (whole tree). The verified-tightest `(file-read-data (literal "/"))`
   (root listing only) can't be expressed in the plain path grammar — needs a generator
   special-case or a `rawAllow` entry. Left as `"/"` for correctness.
2. **`mach-lookup` shipped as curated-18, not the `-p` floor of 1** (`SecurityServer`) —
   TUI-safety margin. Tighten after driving a real tmux TUI.
3. **`signal`/`file-ioctl` dropped on `-p` evidence** — a TUI/child-process path might
   re-need `signal`; re-verify when the TUI is exercised.
4. **`/usr`,`/System`,`/private/var` not dylib-exact** — subpath-granular is the practical
   unit for a dyld-shared-cache binary.
5. **`bunx tsc` needs broad `~/` read** for an uninstalled package — not reduced below
   broad-home; documented mitigations in §c.
6. **`/dev` broad** — exact pane-pty set is runtime-determined; phase-2.
7. **NOT exercised at all:** full interactive tmux TUI, MCP servers, codex (`-s
   danger-full-access` + proxy honoring), `ib new-agent` from a sandboxed manager,
   watchdog spawn inheritance, tmux-socket scoping. These remain the phase-2 backlog from
   spike §8 and are unchanged by this verification.

---

## Reproduction summary

| Deliverable | Script | Result |
|---|---|---|
| `/` mandatory + op-class | `run.ts root-01/02/03`, `probe-root.ts` | SIGABRT w/o `/`; `file-read-data (literal "/")` boots |
| syscall single-removal | `matrix.ts syscalls` | drop signal+ioctl; rest mandatory |
| mach joint-shrink | `machmin.ts` | → SecurityServer (`-p`); ship curated-18 |
| read single-removal + home narrow | `readshrink.ts`, `homefinal.ts` | 5 dotdirs + `-D` read roots |
| network hole bisection | `netbisect.ts` | `lo_out` mandatory; fail-closed proven |
| whole profile 5-check e2e | `e2e2.ts` (`minimal-plus.sb`) | **5/5 PASS** |

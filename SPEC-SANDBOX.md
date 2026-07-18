# SPEC-SANDBOX.md — Per-Agent Seatbelt Sandboxing

**Status:** DESIGN / PLANNING (not yet implemented)
**Author:** planning session 2026-07-17
**Related:** SPEC.md §2 (Agent Types), §6 (Hooks), §7 (Configuration), §18 (Codex CLI)

## 1. Goal

Give each itsybitsy agent an OS-enforced sandbox, configured per agent type in
its `.md` frontmatter:

- **Filesystem**: which paths outside the worktree the agent may read/write.
- **Network**: which domains the agent may reach.

The reference is [agent-seatbelt-sandbox](https://github.com/michaelneale/agent-seatbelt-sandbox),
which wraps an agent process in macOS Seatbelt (`sandbox-exec`) plus a localhost
HTTP/CONNECT proxy that filters outbound domains. We adopt its two-layer model
but make both layers **per-agent configurable** and **allowlist-first**, which
the reference does not do.

## 2. What the reference project actually provides (and its gaps)

| Reference behavior | What we need instead |
|---|---|
| Single hardcoded `sandbox.sb`, **`(allow default)`** (allow-everything-except) | **Generated per-agent**, **`(deny default)`** (Model B: allow only what's listed) |
| One `-D` param: `SECRETS_DIR` (deny one path) | Per-agent allow lists (the primary knob) + deny lists that carve holes |
| Network = **localhost-only** + Python proxy | Same shape, but proxy enforces a **per-agent allowlist** |
| Domain filtering = **blocklist** (`blocked.txt`), global | **Allowlist** (Adam's ask), per-agent |
| Two manual terminals (`start-proxy.sh`, `start-claude.sh`) | Proxy lifecycle owned by itsybitsy; agents wrapped automatically |
| `sandbox.sb` denies network then allows `localhost:*` out | Reusable — this is the exact shape we want |

Key takeaways:

- The Seatbelt profile is the **filesystem + coarse network** layer (block all
  non-localhost egress at the kernel).
- The **proxy** is the **fine-grained domain** layer (an agent's traffic is
  forced through `http(s)_proxy=localhost:PORT`; the proxy allows/denies by
  domain). The kernel can't filter by domain, so the proxy is required for
  domain-level control. **Caveat carried over from the reference:** the proxy
  sees the CONNECT host, not request bodies — POST exfiltration to an allowed
  domain is not caught. And any tool that ignores `*_proxy` env vars simply
  fails closed (kernel blocks it) rather than escaping.
- **macOS only.** `sandbox-exec` is macOS-specific (and Apple-deprecated but
  functional). On non-macOS, `sandbox.enabled: true` **refuses to spawn** (§5.5
  fail-hard) — it does NOT fall back to an unsandboxed run. (`sandbox.enabled`
  absent/false is unaffected everywhere.) This supersedes the earlier
  "degrade to a no-op" idea, which contradicted Adam's fail-hard call (C1).

## 3. How this fits the existing codebase

### 3.1 There are TWO existing precedents to mirror

1. **`allowedPaths`** (`src/agent-types.ts:52`, `src/hooks/agent-path.ts`,
   `src/ib-commands.ts:4496`): a frontmatter `allowedPaths: string[]` that today
   restricts file access **in userspace** via the `agent-path.ts` PreToolUse
   hook. This is *advisory* — it inspects tool-call paths and allows/denies. The
   seatbelt profile is the *kernel-enforced* companion to this. **Design choice:
   reuse/extend `allowedPaths` as the filesystem source of truth** so we don't
   have two competing path lists (see §4.3).

2. **Codex `workspace-write` sandbox** (`src/codex-spawn.ts:189`,
   `src/ib-commands.ts:4721`): codex agents *already* run in an OS sandbox
   (`codex -a never -s workspace-write` with `extraWritableRoots`). itsybitsy
   already computes the correct writable-root set for a worktree agent:
   `resolveGitRevParsePath(workPath, gitCommonDir)` + parent-repo subdirs
   (`src/ib-commands.ts:4721-4724`). **The seatbelt profile for a Claude agent
   must permit exactly this same root set** (the worktree + its shared `.git`
   common dir), or git operations break. Reuse that computation.

### 3.2 The `--effort` feature is the threading template

`effort` was threaded frontmatter → parsed `AgentType` → spawn flag, per memory
[[project_effort_level_feature]]. Its **6 verified touch-points** are the exact
map to follow (all line refs current):

1. `AgentType` interface field — `src/agent-types.ts:46` (`effort?`); add
   `sandbox?` near :52.
2. Parse + inheritance keys — `SCALAR_KEYS` / `EMPTY_STRING_INHERITS`
   `:415-434`; sandbox needs the **mixed** merge rule (see §4.4), not a plain
   scalar entry.
3. Validation — `:807-811` (effort) / `:813-820` (allowedPaths); add a sandbox
   validator alongside.
4. CLI-flag parse + options — `--effort` at `index.ts:1950-1952`;
   `NewAgentOptions` at `ib-commands.ts:3520`.
5. Precedence chain — `ib-commands.ts:4224-4258` (effort, twin of model
   `:4183-4217`) → CLI flag: claude `:4903-4905`; codex
   `mapEffortForCodex` (`agent-cli.ts:124`) → `-c model_reasoning_effort`
   (`codex-config.ts:286-289`).
6. Persist + resume re-derive — `meta` `:4539`, `AgentMeta` `agents.ts:66-73`,
   resume reads from meta `:1317`.

Consume the resolved config when building `start.sh` / `resume.sh` (§3.3).

### 3.3 The two injection points (exact lines)

Both are where `claude` is exec'd inside a generated bash script. **Each has TWO
branches — a `setsid` branch and a bare/no-setsid fallback — and BOTH must be
wrapped.** ⚠️ **On macOS `setsid` is absent, so the bare fallback branch is the
one that actually fires** — treat `:5044`/`:1600` as the primary target for a
macOS-only feature, not the setsid branch:

- **Spawn**: `src/ib-commands.ts:5042` (setsid) / **`5044` (bare — runs on macOS)** —
  `claude --session-id "${sessionUuid}" ${claudeArgs} "$(cat …)" &`
- **Resume**: `src/ib-commands.ts:1598` (setsid) / **`1600` (bare — runs on macOS)** —
  `claude --resume "${sessionId}" ${claudeArgs} &`
- **Codex** has its own pair in `src/codex-spawn.ts:189/191` (spawn) and
  `375/377` (resume) — already sandboxed; network-domain layer would be added
  here too if we extend to codex.

The wrapper transformation at each point:

```bash
# before
setsid claude --session-id "$UUID" $ARGS "$(cat $PROMPT)" &
# after (sandbox enabled) — export proxy vars in start.sh (NO `env` link; see below)
export http_proxy=http://localhost:$PORT https_proxy=http://localhost:$PORT
export HTTP_PROXY=$http_proxy HTTPS_PROXY=$https_proxy
export no_proxy=localhost,127.0.0.1,::1 NO_PROXY=localhost,127.0.0.1,::1
# NODE_OPTIONS="--use-env-proxy" only if the spike confirms the runtime supports it (G5)
setsid sandbox-exec -f "$AGENT_DIR/sandbox.sb" \
  -D "WORKTREE=$WORKTREE" -D "GITDIR=$GITDIR" \
  claude --session-id "$UUID" $ARGS "$(cat $PROMPT)" &
```

**PID / watchdog — confirm exec-in-place (spike item, likely a non-issue).**
`sandbox-exec`, like `setsid`, calls `sandbox_init` then **execs** the target
in place (no fork), so after the exec chain `$!` is the single pid that *is*
`claude` — `CLAUDE_PID=$!` (`:5046`/`:1602`), the meta write, `kill`, and
`wait $CLAUDE_PID` should all keep working unchanged. And `pgrep -P <panePid> -f
"claude"` (`agent-lifecycle.ts:510`) matches the full cmdline, which still
contains `claude`. So this is **very likely fine** — but the spike must *confirm*
exec-in-place rather than trust it. (Reframed from "the design may change": the
review verified this reasoning; keep it as a checklist item, not a blocker.)
**Simplification applied above:** drop the `env` wrapper link entirely — export
the proxy vars in `start.sh` before the launch line. One fewer process in the
chain and zero ambiguity about what `$!` refers to.

## 4. Proposed frontmatter schema

**Enforcement model: DENY-BY-DEFAULT ALLOWLIST (Model B, confirmed by Adam).**
A sandboxed agent can see/reach **nothing** except what the `.md` file explicitly
allows. The `deny` list carves holes *inside* the allowed set. A wide-open agent
is possible — but only by an **explicit** `allowRead: ["/"]` in the `.md`, never
by default. This is the opposite of the reference project's allow-by-default
`(allow default)` skeleton; §5.1 flips it to `(deny default)`.

```yaml
name: netletworker
sandbox:
  enabled: true              # default false → agent runs UNSANDBOXED (today's behavior)
                             # true → deny-by-default; only what's listed below is reachable
  filesystem:
    # Baseline (worktree, git-common-dir, ~/.claude, OS/runtime paths, /tmp, DNS
    # socket) is ALWAYS merged in so the agent can boot — see §4A.7. The lists
    # below ADD to that baseline.
    allowRead:  ["~/.config/foo"]
    allowWrite: ["/tmp/agent-scratch"]
    deny:       ["**/.env", "~/.ssh"]   # carves holes inside the allowed set; deny always wins
    # Fully-open escape hatch (must be explicit, per Adam):
    #   allowRead: ["/"]
    #   allowWrite: ["/"]
  network:
    # deny-by-default too: kernel blocks ALL non-localhost egress; the proxy then
    # permits ONLY these domains. No "blocklist" mode in v1 — allowlist is the model.
    domains: ["api.anthropic.com", "github.com", "*.githubusercontent.com"]
```

Design decisions:

1. **`sandbox.enabled` defaults to `false` → the agent runs fully unsandboxed**
   (exactly today's behavior). This is the ONLY unsandboxed path once the feature
   ships. When `true`, the model is deny-by-default: nothing is reachable but the
   baseline (§4A.7) + the explicit allow lists. There is no "sandbox but
   allow-everything" default — openness is opt-in via `allowRead: ["/"]`.
2. **A required baseline allowlist is always present** (§4A.7) so a sandboxed
   agent can actually start. Deny-by-default is unusable without it: Claude Code
   needs `~/.claude`, `/tmp`, macOS `/private/var/folders/…` caches, system
   dylibs, the DNS socket, plus the worktree + git-common-dir. **Adam's call
   (draft 1): the static part of this baseline is written explicitly in `_all.md`**
   (inspectable/tunable, rides the existing merge), and **only the runtime-derived
   paths (worktree, git-common-dir) are injected by code** as Seatbelt `-D`
   params. Encoding the static list as an itsybitsy default constant is a later
   optimization. Type `.md`s ADD to the `_all.md` baseline; `deny` still carves
   holes.
3. **Domains ALSO all live in `_all.md` — no code constant (Adam's call).**
   `api.anthropic.com` (+ Claude's required control-plane hosts) must be reachable
   or a sandboxed agent can't reach the model at all — but rather than bake an
   Anthropic host list into code, **list every required domain in `_all.md`'s
   `sandbox.network.domains`** and build the list out empirically as we experiment
   (same "don't optimize into a constant yet" stance as the filesystem baseline —
   do NOT over-engineer this). Network is allowlist-only (deny-by-default): kernel
   blocks all non-localhost egress, the proxy permits only the merged `domains`
   (`_all.md` baseline ∪ the type's own).
4. **Relationship to the existing `allowedPaths` hook.** `allowedPaths`
   (`agent-path.ts`) is already a deny-by-default *allowlist* at the hook layer —
   the same model, one layer up. `sandbox.filesystem.allowRead`/`allowWrite` are
   the **kernel-enforced** counterpart. If `sandbox.filesystem` is omitted but
   `allowedPaths` is set, derive the kernel allowlist from `allowedPaths`. If both
   are set, `sandbox.filesystem` is authoritative for the kernel and `allowedPaths`
   stays the hook layer; keep them consistent (§4A.1). Document in SPEC §2.
5. **Inheritance → UNION of all `.md` layers (Adam's call).** Final permissions =
   the sum of every layer: `_all.md` ∪ type ∪ any intermediate. **Both** the
   list fields (`domains`, `allowRead`, `allowWrite`, `deny`) union across the
   chain — a child can **add** access (union its allow) and/or **narrow** access
   (union its deny). Because deny-wins (§4A.0), a child (or any layer) can never
   re-open what another layer denied. Only the scalar `enabled` uses
   last-non-empty-wins (like `model`/`effort` at :415-434). This matches the
   existing `permissions` merge exactly (`mergeRawFrontmatters` :459-467), so the
   list fields can reuse that machinery; only `enabled` needs the scalar rule.

## 4A. Path pattern format for allow/deny lists (AUTHORITATIVE)

This is the exact, user-facing contract for entries in `sandbox.filesystem`'s
`allowRead` / `allowWrite` / `deny` lists. **We own the grammar and compile it to
both enforcement layers**, so the rules below are what itsybitsy guarantees —
independent of Seatbelt or hook internals.

### 4A.0 The core rule (deny-by-default allowlist)

For any absolute path `P` and operation `op ∈ {read, write}`:

```
visible(P, op)  ⟺  matches(P, allow_op)  AND  NOT matches(P, deny)
```

where `allow_read = baseline_read ∪ allowRead`, `allow_write = baseline_write ∪
allowWrite`, and `baseline_*` is the always-merged required set (§4A.7). In
words, and exactly as Adam stated it:

> **The agent can only see what's in the allow lists, unless that file also
> matches a deny rule.**

- **Not in any allow list → invisible** (kernel `EPERM`). This is the default for
  every path once `enabled: true`.
- **In an allow list AND in a deny rule → denied.** `deny` always wins; it carves
  holes *inside* the allowed set. There is no allow rule that can re-open a
  denied path.
- **`write` implies nothing about `read`** — they are separate allow lists.
  Common case: `allowRead` a config dir, don't `allowWrite` it. (A path must be
  read-allowed to be written in practice, but the profile expresses them
  independently; document that writing also needs read where the tool reads
  before writing.)
- **Fully-open** is just `allowRead: ["/"]` (and/or `allowWrite: ["/"]`) — an
  explicit `/` subtree allow. Even then, `deny` still carves holes (e.g.
  `allowRead: ["/"]` + `deny: ["**/.env"]` = see everything except `.env` files).

### 4A.1 The two layers a pattern compiles to

Every pattern is enforced twice, and the generator emits BOTH from one entry:

| Layer | Engine | What it matches | Where |
|---|---|---|---|
| **Kernel** (real enforcement) | Seatbelt SBPL | absolute paths | `sandbox.sb` — `subpath` / `literal` / `regex` |
| **Hook** (advisory, better errors) | `agent-path.ts` | absolute paths | ordered rule cascade |

Both operate on **fully-resolved absolute paths** (symlinks + `~` + `.`/`..`
normalized). Patterns are never matched against relative paths.

### 4A.2 The pattern grammar (exactly three anchor forms)

An entry is classified by how it starts. **There is no other form** — anything
else is a spec error the generator rejects at spawn (fail-closed).

1. **Absolute path** — starts with `/`
   `/Users/adam/.aws`
   → matches that path **and everything under it** (directory subtree).
   Compiles to Seatbelt `(subpath "/Users/adam/.aws")`.

2. **Home-anchored path** — starts with `~/`
   `~/.ssh`
   → `~` expands to the agent's `$HOME`, then same subtree semantics as (1).

3. **Glob pattern** — contains `*`, `**`, or `?`
   `**/.env`, `/Users/adam/**/*.pem`, `~/secrets/*`
   → compiled to a Seatbelt `(regex #"…")` via a fixed, documented glob→regex
   translation (§4A.4). This is the ONLY form that can match by basename
   anywhere on the filesystem.

**Bare names are rejected.** `.env` (no `/`, no glob metachar) is a spec error —
it is neither absolute, home-anchored, nor a glob, so its intent is ambiguous
("relative to what?"). The generator refuses to spawn and tells you to write
`**/.env` (anywhere) or `/abs/path/.env` (one file). This is deliberate: a
silently-misinterpreted deny rule is a security footgun.

### 4A.3 Glob semantics (what the metachars mean)

Standard shell-glob meaning, matched against the absolute path:

| Token | Matches |
|---|---|
| `*` | any run of chars **except `/`** (one path segment) |
| `**` | any run of chars **including `/`** (spans directories, incl. zero) |
| `?` | exactly one char except `/` |
| everything else | literal (`.` is a literal dot, NOT regex "any char") |

So:
- `**/.env` → any path ending in `/.env`, at any depth → **every `.env` on the
  filesystem** (this is the answer to "disallow all `.env` even in the worktree").
- `~/*.pem` → `.pem` files directly in `$HOME`, but not in subdirs.
- `~/**/*.pem` → `.pem` files anywhere under `$HOME`.
- `/etc/ssh` → the whole `/etc/ssh` subtree (absolute form, not a glob).

### 4A.4 Worked example — deny ALL `.env`, even inside the worktree

```yaml
sandbox:
  enabled: true
  filesystem:
    deny: ["**/.env"]
```

This compiles to, and the generator guarantees, BOTH of:

- **Kernel (`sandbox.sb`)** — appended *after* the worktree-allow rules so it
  wins (SBPL = last matching rule decides):
  ```
  (deny file-read*  (regex #"/\.env$"))
  (deny file-write* (regex #"/\.env$"))
  ```
- **Hook (`agent-path.ts`)** — a deny check inserted **before rule 7** (the
  "path within worktree → allow" rule at `agent-path.ts:391`). ⚠️ This ordering
  is the crux: today rule 7 allows anything in the worktree, so a `.env` deny
  placed *after* it would never fire for the project's own `.env`. The
  sandbox-deny list must be evaluated **ahead of** the worktree allow in the
  cascade. (New rule slot, call it rule 6.5.)

**Precedence rule (both layers): `deny` wins over any allow, always.** A path
matched by both an `allowWrite` and a `deny` entry is denied. Document this as
absolute — no "most-specific-match" subtlety.

### 4A.5 The worktree-vs-deny tension (call this out to users)

The worktree is readable/writable because it's in the **baseline allowlist**
(§4A.7) — not because of any allow-by-default. A `deny: ["**/.env"]` **carves a
hole through that baseline inside the worktree too** — the agent will get `EPERM`
reading its own project `.env`. That is exactly what "even in the worktree" means
and is the intended behavior for this rule, but it WILL surprise an agent that
legitimately needs `.env`. The
`session-start` hook (§5.4) should surface active deny patterns in the agent's
prompt so it doesn't burn turns fighting an unfixable `EPERM`.

### 4A.6 Regex is an escape hatch, not the interface

Users write **globs**, never raw regex — globs are safer (no catastrophic
backtracking, no accidental unanchored `.`). Internally the generator translates
glob→SBPL-regex. If a power-user case ever needs raw regex, add an explicit
`regex:` prefix later; do **not** expose Seatbelt regex directly in v1.

### 4A.7 The required baseline allowlist — lives in `_all.md` (Adam's call, draft 1)

Deny-by-default means an empty allow list = an agent that **can't even start**
(Claude Code can't read its own binary's dylibs, config, or write its transcript).
So a baseline read/write allowlist must always be present.

**Decision (Adam, 2026-07-17): for draft 1 the baseline is spelled out
explicitly in `_all.md`, NOT a hidden constant in `src/sandbox.ts`.** Rationale:
`_all.md` already merges into every spawned agent (`agent-types.ts` layer files),
so listing the baseline there makes it **inspectable and tunable** with zero new
mechanism — every type unions it in for free. Encoding it as an itsybitsy default
constant is a **later** optimization, once the list is proven. So:

- The static OS/runtime paths go in `_all.md`'s `sandbox.filesystem.allowRead`
  / `allowWrite` (and the Anthropic domains in `sandbox.network.domains`). Adam
  edits one file to tune the floor; no code change.
- **Only the truly per-agent, runtime-determined paths are injected by code at
  spawn** — because they don't exist until the worktree is created and can't be
  written in a static `.md`:
  - the agent's **worktree** path,
  - the **git common dir** (`resolveGitRevParsePath` — reuse codex's
    computation, `ib-commands.ts:4721`),
  - (candidate) the agent dir + its Claude project dir
    (`~/.claude/projects/<encoded-worktree>`), if those aren't expressible as a
    static parent in `_all.md`.
  These are passed as Seatbelt `-D` params (`WORKTREE`, `GITDIR`, …) by the
  spawn/resume script, exactly like the reference passes `SECRETS_DIR`.

Candidate static `_all.md` contents (finalize empirically in the phase-1 spike —
the exact set is OS/Claude-version-dependent and MUST be verified, not guessed):

- **Read+write:** `/tmp`, `/private/var/folders/**` (macOS per-user temp/caches).
  ⚠️ **NOT `/tmp`** — seatbelt matches CANONICAL paths, and `/tmp` canonicalizes
  to `/private/tmp`; a `subpath` rule on `/tmp` will not match. Use `/private/tmp`
  (consistent with `/private/etc`, `/private/var/folders` already listed).
- **Read+write (correction — `~/.claude` is NOT read-only):** `~/.claude/**` —
  Claude Code writes transcripts (`projects/`), `history.jsonl`, `statsig/`,
  `todos/`, `shell-snapshots/`, and settings write-backs there. The earlier
  "read-only ~/.claude" classification was an error (G5).
- **Read-only:** `/usr/lib`, `/usr/bin`, **`/usr/local/bin`** (where `ib` is
  installed — was missing), `/System/**`, `/bin`, `/private/etc` (system libs,
  resolv.conf, terminfo), the `claude`/`node` binaries + their `node_modules`.
- **Network:** the required domains (see §4 decision 3 — listed in `_all.md`,
  derived empirically; do not hardcode).

See **§4C** for the paths beyond the OS baseline that the sandbox must allow
because the agent's descendants (`ib`, hooks, watchdog, MCP) run under the same
profile — these were the largest gap the design review surfaced.

Two guarantees:
1. **Spawn resolves, meta.json freezes, resume replays from meta — resume does
   NOT re-read the `.md` files** (fixes C2, matches the model/effort convention).
   At spawn, the FULLY-RESOLVED merged sandbox config (unioned allow/deny/domains,
   `enabled`, proxy port) is written to `meta.json`; both `start.sh` and
   `resume.sh` build the profile from that frozen config + the recomputed runtime
   `-D` params (worktree, gitdir). **Consequence, stated explicitly:** editing the
   `_all.md` floor affects NEW spawns only; a live agent keeps its spawn-time
   sandbox until respawned (consistent with §5.4 "profile is fixed at exec").
2. **`deny` still carves into the baseline.** `deny: ["**/.env"]` removes `.env`
   from the `_all.md`-allowed worktree; deny is evaluated last over the full union.

**Merge (§4 decision 5, decided): UNION.** The baseline lives in `_all.md`,
children union their allow lists on top — `_all.md` sets the floor, each type
adds what it needs. `deny` unions too (deny-wins ensures a denied path stays
denied regardless of layer).

## 4B. Codex: disable its built-in sandbox, use ours (Adam's call)

**Decision (Adam, 2026-07-17): a sandboxed codex agent runs codex in its own
"yolo"/no-sandbox mode so codex does NOT double-sandbox, and OUR seatbelt +
proxy is the single enforcement layer.** One mental model, one config surface
(`_all.md` + frontmatter) for both claude and codex agents.

Mechanism — codex's sandbox is set by two flags on its launch line
(`codex-spawn.ts:189/191` spawn, `375/377` resume):
- `-a never` — approval mode (unchanged; don't prompt).
- `-s workspace-write` — codex's OS sandbox. **When `sandbox.enabled: true`,
  change this to `-s danger-full-access`** (codex's no-sandbox mode) so codex
  stops enforcing its own filesystem/network rules.

Then wrap the whole `codex …` launch in `sandbox-exec -f sandbox.sb … env
http(s)_proxy=… codex …`, exactly like the claude wrapper (§3.3). Result: our
profile is the sole authority for both CLIs; no confusing intersection of two
kernel sandboxes.

Why not nest the two sandboxes: two OS sandboxes on one process enforce the
**intersection** of their rules. A path our profile allows but codex's
`workspace-write` forbids would fail with no signal as to which layer blocked it.
`danger-full-access` removes codex's layer so ours is unambiguous.

⚠️ **Spike items for codex (§6):**
1. Confirm `-s danger-full-access` is the correct flag/value in the installed
   codex version (verify against `codex --help`; the flag name may differ by
   version).
2. Confirm codex under `danger-full-access` **honors `http(s)_proxy` env vars**
   so its traffic routes through our allowlist proxy. If it ignores them, the
   kernel layer still blocks its direct egress (fails closed — safe), but codex
   would then only reach allowlisted domains if it respects the proxy. Related:
   the `network_access` wiring at `codex-config.ts:278-279` (the flagged TODO).
3. `-a never` interaction: verify `danger-full-access` + `-a never` doesn't
   re-introduce an approval prompt or change stdin/tty behavior (the `<&0`
   handling at `codex-spawn.ts:189`).

Only when `sandbox.enabled: false` does codex keep its current `-s
workspace-write` behavior (no change from today).

## 5. Components to build

### 5.1 Profile generator — `src/sandbox.ts` (new)

Pure function: `(SandboxConfig, worktreePath, gitCommonDir, agentDir) → string`
producing the `.sb` text. Writes `sandbox.sb` into the agent dir next to
`start.sh`/`meta.json`. **⚠️ Deny-by-default (Model B) — the profile skeleton is
`(deny default)`, the INVERSE of the reference's `(allow default)`.** SBPL uses
last-matching-rule-wins, so the structure is: deny everything → allow the
baseline+config allowlist → re-deny the config `deny` holes last (so deny wins):

```
(version 1)
(deny default)                                   ;; nothing is permitted unless re-allowed below

;; ---- baseline + user allowRead/allowWrite (§4A.7) ----
(allow process*)                                 ;; spawn children, exec (needed for git, node)
(allow sysctl-read) (allow mach-lookup ...)      ;; minimal syscalls Claude/node need to boot
(allow file-read*  (subpath (param "WORKTREE")))
(allow file-write* (subpath (param "WORKTREE")))
(allow file-read*  (subpath (param "GITDIR")))
(allow file-write* (subpath (param "GITDIR")))
(allow file-read*  (subpath (param "ALLOW_R_0")) ...)   ;; from allowRead + read baseline
(allow file-write* (subpath (param "ALLOW_W_0")) ...)   ;; from allowWrite + write baseline
;; glob-form allows compile to (regex #"…") instead of (subpath …)

;; ---- network: deny-by-default egress, localhost hole for the proxy ----
(deny network*)
(allow network-outbound (literal "/private/var/run/mDNSResponder"))   ;; DNS
(allow network-outbound (remote unix-socket))
(allow network-outbound (remote ip "localhost:*"))                    ;; only exit = our proxy
(allow network-inbound  (local ip "localhost:*"))

;; ---- config deny list LAST so it wins over every allow above (§4A.0) ----
(deny file-read*  (subpath (param "DENY_0")) (regex #"…") ...)
(deny file-write* (subpath (param "DENY_0")) (regex #"…") ...)
```

Uses `-D` params for paths (never string-interpolate paths into the profile —
shell-injection surface; the codebase already `shellQuote`s everything). Unit-
testable in isolation (`bun test`), no spawn required.

**⚠️ The hard part is the baseline, not the config.** `(deny default)` +
enumerate-everything is exactly why the reference punted to `(allow default)`.
Getting Claude Code to boot under `(deny default)` requires discovering the full
set of syscalls/paths it touches — this is the bulk of the phase-1 spike (§6).
The syscall allows above (`process*`, `mach-lookup`, `sysctl-read`, dylib reads)
are illustrative, NOT verified. Expect iteration: launch, hit an `EPERM`/kill,
add the minimal allow, repeat, until claude runs clean. Consider generating a
permissive-but-logged profile first (Seatbelt `(trace …)` / `(with report)`) to
harvest the needed rules, then tighten.

### 5.2 Domain proxy — `src/sandbox-proxy.ts` + lifecycle

- **Decided: one proxy PER AGENT** (Adam). Each agent gets its own proxy on an
  allocated port; that port is baked into the agent's `http(s)_proxy` env and
  recorded in `meta.json`. Attribution is trivial (the proxy enforces exactly one
  agent's merged domain allowlist). Lifecycle tied to the agent: started by
  `start.sh`/`resume.sh` before the CLI launch, killed in `teardownAgent`. The
  allowlist is the merged `sandbox.network.domains` (`_all.md` ∪ type), read from
  a per-agent file (e.g. `agentDir/sandbox-domains.txt`) so it's inspectable.
- **Decided: Bun implementation** (`Bun.serve` / raw TCP for CONNECT), not a
  vendored `proxy.py` — the `ib` binary is self-contained (`bun build --compile`)
  and a Python dep would break that. Allowlist-based (deny unless the CONNECT host
  matches a `domains` entry, with `*.`-subdomain support).
- Proxy must be reachable at `localhost:PORT` from inside the sandbox (the
  seatbelt profile already allows `localhost:*` outbound, and the proxy binds
  localhost — inside the sandbox's allowed set).

### 5.3 Wiring

- `AgentType.sandbox` field + parse + validate + merge (`agent-types.ts`).
- `newAgent`: resolve config, compute writable roots (reuse codex's git-common-
  dir logic), generate `sandbox.sb`, allocate proxy port, persist a `sandbox`
  block + `sandbox_proxy_port` to `meta.json` (`ib-commands.ts` ~4525-4547).
- **`AgentMeta` interface + coercion** (`src/agents.ts:50-92` interface,
  `readAgentMeta` ~:975-981 coercion): add the sandbox field to **both**.
  Persisting at spawn is **mandatory** because **resume re-derives model/effort
  from `meta.json`, not the `.md`** (`ib-commands.ts:1289/1317`). If sandbox
  config lived only in the type file, a resumed agent would silently lose (or
  pick up a changed) sandbox after the `.md` is edited. Follow the `effort`
  persistence convention (`effort || null` at `:4539`).
- `start.sh` / `resume.sh` builders: when `meta.sandbox.enabled`, wrap the
  `claude` launch (both setsid + fallback branches) and start the proxy first.
- `teardownAgent` (`ib-commands.ts:365` area): kill the proxy, free the port.
- Codex branch (`codex-spawn.ts`): filesystem already covered by
  `workspace-write`; add the proxy env + domain layer there too if we extend
  network control to codex (phase 2). **The intended home already exists:**
  `src/codex-config.ts:278` has a literal `TODO` "Revisit when we add
  per-agent-type capability gating" directly above the `network_access = true`
  line (`:279`) — that's where codex network gating slots in.

### 5.4 Hooks awareness

- `session-start.ts`: inject a note into the agent's system prompt telling it
  it's sandboxed and which domains/paths are allowed, so it doesn't waste turns
  fighting `EPERM`s it can't fix (mirrors how permissions are surfaced).
- `permission-denied.ts` / `agent-path.ts`: when a denial is actually a sandbox
  kernel block (not a hook block), the error text differs — make sure the
  agent's guidance distinguishes "ask your manager for permission" (hook) from
  "this is kernel-blocked, it can't be granted at runtime" (sandbox). A sandbox
  denial can't be relaxed without a respawn (profile is fixed at exec).
- `ib watch`/dashboard: optional — show a 🔒 indicator for sandboxed agents.

### 5.5 Fail-hard when the sandbox can't be established (Adam's call)

When `sandbox.enabled: true`, the agent **must not start** unless the sandbox is
fully in place. There is no unsandboxed fallback. Preconditions checked at spawn
(and resume), each of which aborts on failure:

- `sandbox-exec` is present and the OS is macOS (else: platform can't sandbox).
- The generated `sandbox.sb` compiles (dry-run / lint the profile before launch).
- The per-agent proxy binds its port successfully.
- (codex) the `-s danger-full-access` flip + proxy env are applied.

On any failure, the spawn/resume path must:
1. **Not exec claude/codex at all** — never a partial or unsandboxed launch.
2. **Log a meaningful, specific error to the agent's `agent.log`** (which
   precondition failed, e.g. "sandbox refused: sandbox.sb failed to compile at
   line N" / "proxy could not bind port P" / "sandbox-exec not found (macOS
   only)").
3. **Surface a clear error to the user** — spawn returns non-zero with an
   explanation; the agent shows as failed-to-start with the reason, not silently
   missing. Mirror the existing spawn-failure surfacing (`newAgent` error paths).

This is the whole point of the feature: an agent that believes it is sandboxed
but isn't is the one outcome we refuse to permit. Wire the precondition checks
into `newAgent` (spawn) and the resume path **before** `start.sh`/`resume.sh` are
written/executed, so nothing launches on a failed precondition.

## 6. Build phases

1. **Spike (blocking) — two things to prove:**
   - **(1a) Plumbing:** wrap one real claude spawn in `sandbox-exec -f` by hand;
     confirm (a) claude starts, (b) `$!`/`pgrep` PID discovery + watchdog still
     work (§3.3 hazard), (c) git ops in the worktree succeed, (d)
     `api.anthropic.com` reachable only through the proxy. **If PID discovery or
     watchdog breaks under sandbox-exec, the whole design changes.**
   - **(1b) Boot Claude under `(deny default)`:** THE hard one for Model B.
     Start from the reference's `(allow default)` to prove plumbing, then invert
     to `(deny default)` + baseline and iteratively add the minimal allows until
     claude runs clean (harvest via a `(with report)`/trace profile). The output
     of this spike **is** the initial `_all.md` filesystem + domain baseline
     (§4A.7). If Claude Code can't be made to boot under `(deny default)` with a
     tractable allowlist, fall back to `(allow default)` + broad denies and tell
     Adam the model can't be as strict as Model B wants. **Do not ship a baseline
     that wasn't empirically derived.**
2. **Filesystem layer + fail-hard:** `src/sandbox.ts` generator + `sandbox.enabled`
   + `sandbox.filesystem` frontmatter, wrap spawn+resume, the §5.5 precondition
   checks (no unsandboxed fallback), persist to meta.json. No network yet (kernel
   blocks egress). Tests + tsc.
3. **Network layer:** per-agent Bun proxy + domain allowlist + port in meta.json +
   lifecycle (start/resume/teardown), `_all.md` domain baseline.
4. **Inheritance (union) + validation + `_all.md` interaction**, SPEC.md §2/§7
   updates, `docs/agent-types/*.md` doc updates.
5. **Codex parity:** `-s danger-full-access` flip + same sandbox-exec/proxy wrap
   for codex (§4B). Not optional — codex is a first-class sandboxed CLI.
6. **Dashboard indicator** (optional): 🔒 for sandboxed agents.

Each phase: `bun test` green + `bunx tsc --noEmit` clean (CLAUDE.md gate), then
a review cycle (2 worker reviewers) before merge.

## 7. Open questions for Adam

**RESOLVED (Adam, 2026-07-17):**
- ✅ **Enforcement model → Model B (deny-by-default allowlist).** Agent sees only
  what allow lists permit, minus anything a `deny` rule matches (§4A.0). Fully-open
  is explicit-only (`allowRead: ["/"]`).
- ✅ **Baseline location → everything in `_all.md`** (§4A.7, §4 decision 3). Static
  filesystem paths AND all required domains are listed explicitly in `_all.md`;
  built out empirically as we experiment — **no code constant, do not
  over-engineer**. Only worktree + git-common-dir are runtime-injected as `-D`
  params.
- ✅ **Proxy topology → one proxy PER AGENT** (§5.2). Port recorded in meta.json;
  lifecycle tied to the agent (started by start.sh/resume.sh, killed in teardown).
  Trivial attribution, worth the N small processes.
- ✅ **Proxy implementation → Bun** (`Bun.serve`/raw TCP), not vendored `proxy.py`
  — keeps the `ib` binary self-contained.
- ✅ **Codex → disable its built-in sandbox, use ours** (§4B). `-s workspace-write`
  → `-s danger-full-access` when `sandbox.enabled`, then wrap in our sandbox-exec
  + proxy. Single enforcement layer for both CLIs. Network layer applies to codex
  in v1 (not deferred).
- ✅ **Failure mode → FAIL HARD, never start unsandboxed.** If `sandbox.enabled:
  true` and the sandbox can't be established (`sandbox-exec` missing, profile
  won't compile, proxy won't bind), **do NOT start the agent.** Fail hard: log a
  meaningful error to the agent's `agent.log` and surface a clear error message to
  the user (spawn returns non-zero with an explanation). An agent that believes it
  is sandboxed but isn't is the exact case we refuse to allow. See §5.5.
- ✅ **Inheritance → union (sum of all `.md` files).** Final permissions = the
  union of every layer's lists (`_all.md` ∪ type ∪ …), for BOTH `allow*` and
  `deny`. A child can **add** access (union its allow) or **narrow** access (union
  its deny); because deny-wins (§4A.0), a child can never re-open what any layer
  denied. Matches the existing `permissions` merge (`agent-types.ts:459-483`).
  Only the scalar `enabled` uses last-non-empty-wins.
- ✅ **`allowedPaths` relationship** (§4 decision 4): sandbox filesystem is the
  kernel counterpart to the existing `allowedPaths` hook (both deny-by-default
  allowlists), not a parallel conflicting list.

**STILL OPEN (empirical — answered by the phase-1 spike, not by decision):**
1. **Feasibility of `(deny default)` for Claude Code** (spike §6.1b): if Claude
   Code can't boot under a tractable deny-by-default allowlist, do we accept
   `(allow default)` + broad denies as a fallback, or hold to the strict model?
   Conscious decision after the spike, not a silent downgrade. The spike's output
   also **is** the initial `_all.md` filesystem + domain baseline.
2. **Codex `danger-full-access` specifics** (spike §4B): exact flag/value in the
   installed codex version, and whether codex honors `http(s)_proxy` under it.

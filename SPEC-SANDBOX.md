# SPEC-SANDBOX.md — Per-Agent Seatbelt Sandboxing

**Current contract (2026-09-08):** kernel sandboxing defaults to enabled for repository agents and per-repository coordinators (Claude, Codex/fugu, and agy). Agent types may declare `sandbox: true` / `sandbox: false`, or an object with boolean `sandbox.enabled`, `rawAllow`, and `domains`. Enablement follows the most specific explicit value: `_all` → applicable `_non_coordinator` → oldest ancestor → leaf. Omission inherits; only final resolution defaults to true. Lists still union independently.

Enabled mode runs the agent under itsybitsy's `sandbox-exec` profile and egress proxy. The resolved path configuration supplies the coarse kernel rules, while hooks enforce agent-type tool permissions and finer path isolation. An explicit false omits only the itsybitsy kernel wrapper, proxy, and kernel-denial collector, restoring pre-sandbox launch behavior. Hooks remain installed in both modes and must resolve every tool allow/deny without handing an approval prompt to the user.

The CLI launch contract is mode-specific only where process confinement changes:

| CLI | Kernel enabled | Kernel disabled |
|---|---|---|
| Codex/Fugu | Always `-a never`; `-s danger-full-access` inside the itsybitsy wrapper. | Always `-a never`; explicit `-s workspace-write`; no itsybitsy wrapper/proxy/collector. |
| Agy/Gemini | Always `--dangerously-skip-permissions --mode=accept-edits`; fail-closed hooks retained; runs inside the itsybitsy wrapper. | The same flags and fail-closed hooks; no itsybitsy wrapper/proxy/collector. |
| Claude | Adds `--dangerously-skip-permissions` inside the itsybitsy wrapper. PreToolUse explicitly allows or denies before native permission resolution, with `permissions.deny` checked first. | Emits neither `--dangerously-skip-permissions` nor `--permission-mode`; no itsybitsy wrapper/proxy/collector. The same PreToolUse contract prevents prompts and rejects denied or unlisted calls. |

For Claude `worktree: false` sessions (per-repository coordinators and regular
`--no-worktree` agents), the generated settings live at the agent-local
`<agentDir>/.claude/settings.local.json`, are passed via `--settings`, and are
read directly by the itsybitsy hook as the agent policy. Normal user/project
settings still load and may further restrict behavior; their files are not
modified. There is no setting-source override. Spawn, resume, rehire, and
refresh preserve this arrangement and the mode split above.

No-worktree execution is unsupported for Codex, Fugu, and agy. Their create
paths reject `--no-worktree` before side effects, and resume/rehire reject any
non-Claude `worktree: false` metadata before hook/rule regeneration or shared
file mutation.

Enabled launches fail closed if profile or proxy setup fails. Spawn freezes policy in metadata, resume preserves it, and `ib sandbox refresh` applies current type settings in either direction. Global `@system` sandboxing remains deferred.

This contract supersedes the mandatory-only and earlier opt-in/OR-merge contracts recorded in the historical sections below, including retired-key diagnostics, rejection of every disabled resume, and the former rule that native approval-bypass flags existed only under Seatbelt. Existing path precedence, enabled-policy sealing, and the documented spawner tmux limitation still apply. See [the type guide](docs/agent-types/README.md) for authoring and [the rollout guide](docs/SANDBOX-ROLLOUT.md) for enabled-mode validation evidence.

# Historical appendix: earlier sandbox designs

The remainder of this document preserves earlier design decisions, migration instructions, and implementation ledgers for reference. It is not the current configuration or launch contract. In particular, old opt-in defaults, OR-merge rules, mandatory-only wrapping, and retired-toggle instructions must not be applied. Use the current contract above, SPEC.md, and the agent-type guide for current behavior.

**Design history:** initial planning 2026-07-17; opt-in implementation 2026-07-19.
**Related:** SPEC.md sections 2, 6, 7, and 18.

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
  functional). Because the sandbox is mandatory, on non-macOS **every launch
  refuses to spawn** (§5.5 fail-hard) — there is no unsandboxed fallback. This
  supersedes the earlier "degrade to a no-op" idea, which contradicted Adam's
  fail-hard call (C1).

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

✅ **Implemented:** the shared sandbox wiring is in `src/ib-commands.ts`; under
the mandatory contract both Codex launch builders in `src/codex-spawn.ts` always
select `danger-full-access` under our wrapper — the `workspace-write` fallback is
gone.

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
# after (mandatory sandbox wrap) — export proxy vars in start.sh (NO `env` link; see below)
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

> **Mandatory-contract note (2026-09-05).** `sandbox.enabled` is no longer parsed
> from agent-type Markdown; the sandbox is applied at every launch (§1, §5.5).
> The author-configurable keys are exactly `paths.allowRead`/`allowWrite`/`deny`,
> `sandbox.rawAllow`, and `sandbox.domains`. `enabled` survives only as **internal**
> resolved `sandbox` metadata — for legacy detection, sealed-record compatibility,
> and operator display — and is always `true` for a newly resolved policy. Where
> the schema example and merge rules below still show or discuss `enabled` as an
> author toggle or an opt-in default, treat that as historical and superseded.

⚠️ **Schema uses two FLAT top-level blocks — ONE level of nesting.** The
frontmatter parser supports a parent object with scalar/list children, exactly
as `permissions:` does. Filesystem policy lives under `paths:` with exactly the
three list children `allowRead`, `allowWrite`, and `deny`. Raw SBPL and network
domains live under `sandbox:` with `rawAllow` and `domains` (the resolved block
also carries the internal `enabled` flag, no longer authored — see the note
above). No deeper `filesystem:` or `network:` objects are supported.

⚠️ **NO trailing inline `#` comments.** The parser strips only FULL-LINE comments
(`agent-types.ts:102`); a trailing `# …` reaches the value unstripped, so a
scalar like `model: opus  # note` parses to the string `"opus  # note"`, and
`deny: [...]  # note` loses its closing `]` and the whole list silently becomes
one garbage string — the exact footgun §4A.2 warns about. Keep comments on their
own lines only:

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
  # (no `enabled` key — the sandbox is mandatory; see the note above)
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
reject non-list path children, unknown keys, malformed path grammar, non-list
sandbox children, and malformed `rawAllow`. A `sandbox.enabled` key in Markdown is
now a **retired-key migration error** (flagged by `ib init-types --check`), not a
parsed toggle.

✅ **Implemented in `src/agent-types.ts` and `src/sandbox.ts`:** both shipped
blocks are flat. The three path lists and the two sandbox lists union and dedupe
within their respective lists across layers, and the two validators enforce their
independent schemas. `enabled` is not merged from Markdown (it is not authored;
the resolved policy is always enabled).

Design decisions:

1. **The sandbox is mandatory — there is no unsandboxed path.** Every launch is
   wrapped (§1, §5.5); a platform, profile, or proxy that cannot support it fails
   closed rather than degrading. The model is deny-by-default: nothing is reachable
   but the baseline (§4A.7) + the explicit allow lists. There is no "sandbox but
   allow-everything" default — openness is opt-in via `paths.allowRead: ["/"]`.
   (Historically `sandbox.enabled: false` was the default and the only unsandboxed
   path; that toggle is retired.)
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
   re-open what another layer denied. The scalar `enabled` is **no longer merged
   from Markdown** — it is not authored, and the resolved policy is always enabled
   (§1). (Historically it OR-merged so a leaf type could not set `enabled: false`
   to switch OFF a sandbox `_all.md` turned on; the mandatory contract makes that
   moot.)
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
  every path — the sandbox is always applied.
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
allow — including the root-node read claude needs to boot (as of A3 the
`rawAllow` line `(allow file-read-data (literal "/"))`, superseding the earlier
`allowRead: ["/"]` → `(subpath "/")` whole-tree form), and the OS/dylib read
paths — is a line in `_all.md` that the
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

**Shipped baseline sync (2026-07-19):** `docs/agent-types/_all.md` no longer
carries a `sandbox.enabled` key (retired under the mandatory contract). Its domain
floor is now `api.anthropic.com`,
`*.anthropic.com`, `platform.claude.com` (required by Claude 2.1.215),
`chatgpt.com`, and `api.openai.com` (Codex). It grants `~/.codex` read+write and
adds `(allow file-ioctl)` for the Codex TUI. These are shipped additions beyond
the earlier Claude-headless minimum; the two findings documents remain the
historical spike record and are intentionally unchanged.

**A3 floor tightening (2026-09-02).** The `_all.md` floor is now the verified
minimum. `paths.allowRead` **drops `/` and `~`**: the root-directory listing
claude's Bun/Node runtime needs at init moves to the `sandbox.rawAllow` line
`(allow file-read-data (literal "/"))` (the root NODE listing only, not a
whole-tree read), and home is no longer a read ancestor. Known cost, documented
as an own-line comment in `_all.md`: `bunx tsc` on a worktree without
`node_modules` scans several home locations and needs broad home read, so a type
that runs the dev gate on an uninstalled worktree adds `~` to its own
`allowRead`. `paths.allowWrite` carries the `~/.itsybitsy` write floor a running
agent needs (`agents`, `teams`, `teams.json`, `teams.json.tmp`, `.teams.lock`);
`~/Library/Caches` is deliberately absent (toolchain caches are per-type). A LIVE
boot gate in `src/sandbox.test.ts` proves the tightened floor still boots claude
(no SIGABRT), matching `docs/SANDBOX-BASELINE-MINIMAL.md §(d)`'s exit-143
fail-closed proof. The boot gate is **opt-in** (it runs a real claude that hangs
on the kernel-denied network for the run timeout), so an ordinary `bun test`
skips it; run it with:

```
IB_LIVE_BOOT=1 bun test src/sandbox.test.ts --test-name-pattern "LIVE claude boot"
```

The 1-second LIVE kernel probe (floor rows, `ls /` vs `ls /Applications`, tmux
deny) stays on by default.

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
sort. `AGENTDIR`, `WORKTREE`, and `GITDIR` join the table as write roots. The
remaining runtime roots are **keyed on the resolved `canSpawnChildren`** (A3):
`REPOAGENTS` is a **write** root for a spawner and a **read** root otherwise, and
`PARENTCLAUDE` (`<repo>/.claude`) joins as a **write** root only for a spawner,
as does the **read-only** `REPOID` (`<repo>/.ittybitty/repo-id`, one file; see
§4C.1 for why it is never writable).
Their resolved `-D` values determine their specificity, while the emitted
matchers remain `(param "NAME")`. There is also one **runtime deny root**,
`TMUXSOCK` (`/private/tmp/tmux-<uid>`), emitted for a non-spawner in the config
`deny` block after the allow table (both operations denied), so it carves the
tmux socket out of the `/private/tmp` write floor (§4C.3). This table is
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
`(allow file-write*)`) for exactly that reason. The one sanctioned rawAllow that
widens filesystem access is the mandatory root-directory listing `(allow
file-read-data (literal "/"))`. **As of A3 this divergence is LIVE:** the floor
has dropped `/` from `allowRead` and carries the root listing as that rawAllow
line instead, so `resolvePathAccess("/", "read")` returns `deny` while the kernel
permits only the directory listing of the root node (`ls /` succeeds; a read of
any file under `/` outside the floor does not). This is the one sanctioned
divergence and is not modelled on purpose. The LIVE macOS probe in
`src/sandbox.test.ts` exercises it directly: `ls /` succeeds under the profile
while the resolver reports `deny` for a read of `/`, and `ls /Applications`
(outside the floor) is denied by both. No other rawAllow line is expected to
widen filesystem access, and any that does is outside the resolver's contract.

Divergence can also go the other way: rawAllow is verbatim SBPL and may carry
`(deny …)` lines that *narrow* the kernel below a resolver `allow` (Seatbelt is
last-match-wins and rawAllow is emitted after the allow table, so a rawAllow
`deny` can override a path the table allowed). So a resolver `allow` is a
statement about the `paths` table, not a guarantee about the kernel: the kernel
may be wider (a widening rawAllow) or narrower (a narrowing rawAllow `deny`) than
the resolver predicts. Only the `paths` table is authoritative for
`resolvePathAccess()`.

## 4B. Codex: disable its built-in sandbox, use ours (historical enabled-mode record)

> **Superseded launch split:** the rationale below still explains enabled mode,
> but disabled mode now restores `-s workspace-write`; `-a never` and hooks are
> retained in both modes. The current table at the top of this file governs.

**Decision (Adam, 2026-07-17): a sandboxed codex agent runs codex in its own
"yolo"/no-sandbox mode so codex does NOT double-sandbox, and OUR seatbelt +
proxy is the single enforcement layer.** One mental model, one config surface
(`_all.md` + frontmatter) for both claude and codex agents.

Mechanism — codex's sandbox is set by two flags on its launch line
(`codex-spawn.ts:189/191` spawn, `375/377` resume):
- `-a never` — approval mode (unchanged; don't prompt).
- `-s workspace-write` — codex's OS sandbox. **Under the mandatory contract this
  is always `-s danger-full-access`** (codex's no-sandbox mode) so codex stops
  enforcing its own filesystem/network rules and our Seatbelt wrap is the sole
  boundary.

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
always select `-s danger-full-access` under our Seatbelt wrapper, and export the
same proxy environment. There is no `-s workspace-write` path left — the builders
refuse to emit an unwrapped codex line.

✅ **Codex spike items resolved by the shipped phase-5 path (§6):**
1. The installed Codex accepts `-s danger-full-access`; both generated launch
   paths select it only under our wrapper.
2. Codex honors the exported `http(s)_proxy` variables and reaches its allowed
   endpoints through the per-agent proxy; direct egress still fails closed.
3. `danger-full-access` + `-a never` retains non-interactive approval behavior
   and the existing `<&0` TTY handling on spawn and resume.

The installed CLI accepts `danger-full-access`, and Codex runs through the
per-agent proxy without reintroducing approvals. The shipped `_all.md` includes
`chatgpt.com` and `api.openai.com`; because proxy apex entries are exact,
subdomains remain denied unless explicitly added.

### 4B.1 Claude: skip its own permission prompts only under the kernel (historical mandatory-contract wording)

> **Superseded scope:** enabled Claude still adds the flag described below.
> Disabled Claude now emits neither that flag nor `--permission-mode`, while
> explicit PreToolUse allow/deny prevents prompts in both modes. The current
> table at the top of this file governs.

**Decision (Adam, 2026-09-02): NEVER yolo without the kernel.** Codex's
`-a never` already suppresses its approval prompts under our wrapper; the claude
equivalent is `--dangerously-skip-permissions`, gated the same way — it rides
**inside** the Seatbelt wrapper that is the enforcement layer, never without it.
Under the mandatory contract every claude launch is wrapped, so the claude launch
line in **both** `start.sh` (spawn) and `resume.sh` (resume) always gains
`--dangerously-skip-permissions`, emitted **inside** the `sandbox-exec -f … claude
…` wrapper (both the `setsid` and the plain-background arms). The invariant is
that the flag is present **iff** the sandbox prefix is present. The claude-only
flag never leaks into the codex or agy launch lines (codex has its own no-prompt
mode; agy runs under its own mandatory wrap with its own launch flags — §19).
✅ **Implemented in `src/ib-commands.ts`:** the flag is appended to `claudeArgs`
only when `preparedSandbox`/`preparedResumeSandbox` is non-null — exactly the
condition that installs the sandbox-exec launch prefix — so "flag present iff
kernel present" falls out of the gate itself.

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

  **A3 shipped (2026-09-02).** The runtime roots are now keyed on the resolved
  `canSpawnChildren` (metaCanSpawnChildren: per-agent meta override, then the
  type), passed into `prepareSandbox` at spawn (from `initialMetaJson`) and
  resume (from `agent.meta`). For a spawner, **REPOAGENTS**
  (`<repo>/.ittybitty/agents`) becomes a **write** runtime root (it writes the
  child's agent dir) and **PARENTCLAUDE** (`<repo>/.claude`, where `newAgent`'s
  non-coordinator settings-merge branch writes `rootSettingsPath` =
  `<rootRepoPath>/.claude/settings.local.json`) is added
  as a **write** runtime root. A non-spawner keeps REPOAGENTS **read-only** and
  gets neither PARENTCLAUDE nor the tmux socket (§4C.3). This is the
  `sandbox-safety`-split "runtime roots keyed on `canSpawnChildren`" from
  `SPEC-PATH-ALLOWLIST.md §6.11 item 7`, and it fixes the previously-noted gap
  where a sandboxed manager's `ib new-agent` failed on a read-only repo agents
  dir. Grant is by evidence only — PARENTCLAUDE is the sole extra parent-repo
  write `newAgent` performs for a child.

  **REPOID (added 2026-09-29).** `newAgent` (and rehire / `ib sandbox refresh`)
  also READ `<repo>/.ittybitty/repo-id` through `getRepoId` to name the child's
  tmux session (`ittybitty-<repoId>-<agent>`) and key its sealed record. Only
  `.ittybitty/agents` was granted, so a sandboxed spawner saw the file as
  missing and `ib new-agent` failed trying to create it. A spawner now gets that
  one file as a **read-only** runtime root (`REPOID`, `SandboxProfileParams`
  optional field; a non-spawner never gets it). It is deliberately not writable:
  the id keys every session name and seal of the repo. `getRepoId` correspondingly
  creates an id only on `ENOENT` and throws on any other read error, so an
  unreadable id is never regenerated. A repo whose id file does not exist yet must
  have it created by an unsandboxed `ib` first.

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
`tmux run-shell -b '<wrapper>'` where the wrapper (`buildTmuxHelperScript`)
`cd`s to `<cwd>`, runs `… >>log 2>&1` as a backgrounded child, waits for it,
and always exits 0. cwd is set with a quoted `cd` prefix, not `run-shell -c`, to
remain compatible with tmux releases predating that flag. The watchdog records
its authoritative PID in transient state; test overrides retain the direct PID
return used by deterministic tests and legacy meta.

**Why the wrapper (regression fixed 2026-09-05):** a background `run-shell -b`
job has no client and no target pane, so when it prints, exits non-zero, or dies
by a signal, tmux writes a `'<cmd>' terminated by signal 15` notice into the
active pane of the most recently created/attached session and parks that pane
in **view-mode** — after which every `send-keys` to that pane is misrouted
through the copy-mode key table and the agent silently stops receiving messages.
The orphan-kill SIGTERM to a stopping agent's watchdog triggered exactly this on
some other agent's pane at every teardown. The wrapper keeps the job's own stdio
empty, preserves the helper's status in its log (`[helper] exited rc=N`), traps
signals aimed at the wrapper (forwarding SIGTERM to the helper), and reports 0.
Delivery additionally probes `#{pane_in_mode}` and cancels an active mode
(`cancelTmuxPaneModeIfActive`). See docs/codex-cooked-tty-wedge.md.

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

**Shipped state (A3, 2026-09-02):** the recommendation above is now **shipped for
non-spawners.** `_all.md` still grants `/private/tmp` read+write, but the
generator now emits a runtime **deny** for the tmux socket
(`/private/tmp/tmux-<uid>`, uid from `process.getuid()`) for both operations when
the resolved `canSpawnChildren` is **false**, carving the socket out of the
`/private/tmp` write floor **after** the allow table (the same last-match-wins
position as a config `deny`). A **spawner** (`canSpawnChildren: true`) emits
nothing here and keeps the socket — `ib new-agent` creates tmux sessions, so the
escape stays an **accepted limitation** for spawning types, exactly as
recommended. The deny is a runtime deny root (§4A.8), sorted with the config
denies; the LIVE macOS probe proves a non-spawner is denied writing the socket
while a `/private/tmp` sibling stays writable, and a spawner writes both.

⚠️ **The file deny does NOT close the socket by itself.** Reaching the tmux
server is a **unix-socket `connect()`**, which Seatbelt gates under
`network-outbound`, not `file-read*`/`file-write*` — and `_all.md` carries a
blanket `(allow network-outbound (remote unix-socket))`. So a non-spawner also
gets a **scoped network-outbound deny** for the socket dir,
`(deny network-outbound (remote unix-socket (subpath (param "TMUXSOCK"))))`,
emitted after `rawAllow` so it last-match-wins over that blanket allow (verified
live: `nc -U <socket>` connects with only the file deny; it fails once the
network deny lands, while a unix socket outside the dir still connects). The
socket dir is derived the way tmux resolves it (`resolveTmuxSocketDir`): the
directory of `$TMUX`'s first field if set, else `${TMUX_TMPDIR:-/tmp}/tmux-<uid>`.

✅ **Trust boundary CLOSED for non-spawners by the SEALED RECORD (A4 G3).**
`AGENTDIR` is a kernel write root because the agent-session hooks write
`meta.json` there (`writeAgentState`), so `meta.canSpawnChildren` and
`meta.agentType` live inside a path the agent itself can write, and
resume/respawn **re-derive** the runtime roots from `meta` (§4A.8). Without a
countermeasure a sandboxed non-spawner could edit its own `meta.json` to set
`canSpawnChildren: true` (or swap `agentType` to a spawning type) and then
`ib respawn`/resume itself into a **spawner** profile. A4 G3 closes this:

- **The seal.** A per-agent record at `~/.itsybitsy/sealed/<repoId>-<agentId>.json`
  holds the profile inputs `{agentType, canSpawnChildren (resolved via
  `metaCanSpawnChildren`), paths, sandbox: {enabled, rawAllow, domains}}` as
  canonical JSON plus a sha256 over them (`src/agent-seal.ts`).
- **The seal dir is agent-unreachable.** `_all.md` `paths.deny` lists
  `~/.itsybitsy/sealed` (deny wins over the `~/.itsybitsy` read floor and cannot
  be re-opened by any layer), so a sandboxed non-spawner can neither read its own
  seal nor forge one. The LIVE probe proves both ops are denied under it.
- **The seal is written by unsandboxed lifecycle ops.** `newAgent` seals every
  new agent right after the early meta write; `ib sandbox refresh` re-seals;
  `rehire` re-seals; `nuke`/`retire` delete it. `sealAgentRecord` tries a direct
  write and, on `EPERM`/`EACCES` (a **sandboxed spawner** that cannot write the
  denied dir), re-runs itself as `ib sandbox seal <id>` **synchronously** through
  the unsandboxed tmux server (`run-shell` WITHOUT `-b`), which recomputes the
  record from the read-only type files + the agent's meta and writes it. The
  record is computed from the read-only type files (for `canSpawnChildren`
  resolution) plus the meta the spawner just wrote, so it captures the
  *legitimate* profile at seal time and a later meta edit is exactly the
  divergence it detects.
- **Verification.** `resumeAgent`, `respawnSelf` (which resumes through the same
  path), and `ib sandbox refresh` (before its own re-seal) compare the agent's
  current inputs against the seal on every launch; on any mismatch they **fail
  hard** — the agent is left stopped, the differing field is named in `agent.log`,
  and stderr reads `sandbox refused: meta.json does not match the sealed record
  (<field>); run \`ib sandbox refresh <id>\` from an unsandboxed session to
  re-seal`. A missing seal is refused by resume/respawn with its own message
  (pointing at refresh); **refresh** treats a missing seal as "seal it now" so a
  legacy agent is recoverable, but refuses a genuine mismatch so a tampered meta
  cannot be laundered into a new seal. (Legacy metadata whose frozen policy
  predates the mandatory contract cannot launch until refreshed anyway — §5.5.)

⚠️ **Residual (accepted).** A **SPAWNER** can still reach the seal dir the same
way it reaches everything else off-limits — through the **tmux socket**, the
accepted spawner escape above (`tmux run-shell 'cat|tee ~/.itsybitsy/sealed/…'`
runs unsandboxed). The seal protects **non-spawners**, whose tmux socket is
denied. Closing the spawner path would mean closing the tmux escape itself, out
of scope here. Documented in §4C.5.

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

✅ **The spawn keying is now tamper-evident for non-spawners (A4 G3).** Because
`AGENTDIR` is agent-writable (hooks write `meta.json` there) and resume/respawn
re-derive the runtime roots from `meta` (§4A.8, §4C.3), the `canSpawnChildren`
keying — REPOAGENTS write, PARENTCLAUDE, and the tmux escape — is only as strong
as `meta` is trustworthy. A3 raised the bar (a non-spawner is genuinely fenced
*until* it rewrites its own meta) but did not make the spawn boundary
unforgeable. **A4 G3's sealed record (§4C.3) closes this for non-spawners:** the
profile inputs are recorded by an unsandboxed lifecycle op under a path the
`_all.md` `deny` carves out of every agent's reach, and resume/respawn/refresh
**fail-hard** on any mismatch between `meta` and the seal. A sandboxed
non-spawner that edits its own `meta.canSpawnChildren`/`agentType` and tries to
respawn is now refused, not promoted. **Residual (accepted):** a **spawner** can
still reach the seal dir through its tmux socket (the same accepted escape that
lets a spawner run anything unsandboxed), so the seal hardens the non-spawner
boundary, not the spawner one. Set expectations accordingly in §1.

### 4C.6 Sandboxed spawn: the watchdog spawn broker (2026-09-29)

**Problem.** A sandboxed `ib new-agent` cannot do the spawn work itself. Measured
with a real agent profile: (1) `sandbox-exec` for the child's profile from inside
the parent's sandbox fails with `sandbox_apply: Operation not permitted`
whenever the child grants anything the parent does not (it always does: its own
worktree and agent dir), which is what `prepareSandbox`'s compile lint does;
(2) binding the child's proxy port is denied (`EADDRINUSE`-shaped); (3) starting
the child needs the tmux server, i.e. the §4C.3 escape. Two smaller findings
shipped with it: a compiled Bun binary scans its cwd's ancestors for `.env` /
`bunfig.toml` at startup and, when those directories are unreadable, starts with
an EMPTY environment — hence the `--no-compile-autoload-dotenv
--no-compile-autoload-bunfig` build flags (AGENTS.md) — and `getRepoId` no longer
regenerates an id it merely could not read.

**Design.** The agent's watchdog is started by the tmux server (§4C.2), so it is
UNSANDBOXED. A sandboxed `ib new-agent` therefore hands the request to its own
watchdog, which performs the normal `newAgent()` flow. The child is then
launched as always: its CLI wrapped in its OWN profile by `start.sh`, plus its
own unsandboxed watchdog. This needs no `ib watch`, no coordinator and no
tmux-socket access from the requester.

- **Detection** — `isSandboxedProcess()` (`src/sandbox-detect.ts`): macOS
  `sandbox_check(pid, NULL, 0)` via `bun:ffi`. Asks the kernel, so it cannot be
  forged by an env var or file, and it is 1 under any profile and 0 outside
  (probed in a compiled binary). It only ROUTES: a failure to ask means "not
  sandboxed" and the direct path runs (which the sandbox itself still limits).
  Unsandboxed callers (humans, the TUI, the watchdog itself) never use the broker.
- **Queue** — files in the requester's own agent directory (`AGENTDIR`, always
  writable to it): `spawn-requests/<id>.json` (client to watchdog) and
  `spawn-results/<id>.json` (watchdog to client). `<id>` is 32 hex chars; any
  other file name is ignored. Writes are temp-file + rename.
- **Request** — `{v:1, id, prompt, type?, name?, effort?, manager?, noWorktree?}`.
  The FULL prompt text is inside the JSON: the sandbox reads any `-f` file, and
  the unsandboxed watchdog never reads a path on the agent's behalf. Any other
  field (`model`, `repo`, `spawnedBy`, `_trustedCaller`, ...) is rejected.
  `--repo` and `--spawned-by*` are refused client-side inside a sandbox.
- **Client** — `requestSpawnViaWatchdog`. It identifies the caller
  (`resolveCallerAgentContext`), refuses `--model` and oversize prompts, then
  checks `hasLiveWatchdog(agentDir)` (a fresh `meta.transient.json` heartbeat,
  under 15s old, with a live `watchdog_pid`) and, if the watchdog is not live,
  FAILS AT ONCE with a clear message instead of waiting. Otherwise it writes the
  request and polls for the result, giving up after **30 seconds**
  (`SPAWN_CLIENT_TIMEOUT_MS`) so the command can never hang. On timeout it
  withdraws the request if the watchdog has not taken it. A spawn the watchdog
  already started may still complete after a timeout; this is accepted and the
  message says to check `ib list`.
- **Server** — `processSpawnRequests`, run by `runPerAgentWatchdog` every tick and
  on an `fs.watch` of the request directory, NOT awaited by the loop (a spawn
  takes seconds and must not stall state detection or the outbox drain), at most
  one at a time. Each request is deleted BEFORE it is acted on (at-most-once: a
  request that crashes the handler is never retried in a loop). The caller's
  identity comes from the agent's own `meta.json`, which the watchdog verifies
  against the SEALED record (§4C.3, `verifyAgentSealChecked`): an agent cannot edit
  `canSpawnChildren` into existence. The verified caller is passed to `newAgent()`
  as `_trustedCaller` (a cwd lookup cannot work from the watchdog: for a
  `worktree:false` agent it checks process ancestry, and the watchdog is not a
  descendant of the agent's CLI), so every ordinary caller gate — spawn
  permission, user-only `--model`, `spawnedBy`, manager auto-detect — applies to
  the requester exactly as in a direct call. Results over 64 KiB are clipped;
  uncollected results are pruned after 10 minutes.
- **Old watchdogs** predate this and do not read requests; restart the agent so
  its watchdog picks up the feature (no capability marker is checked).

**Verified.** Unit tests (`src/spawn-broker.test.ts`, watchdog tests); and a live
run of the compiled `ib` inside a real deny-default agent profile as the client
against the broker code as an unsandboxed server: the spawn request was handled
in ~1s with the right caller and cwd, a stale heartbeat failed in ~1s, `--repo`
and `--model` were refused, and both queue directories were left empty.

**Known limitations.**
1. While a spawner holds a WRITE grant on `<repo>/.ittybitty/agents` (§4C.1, A3)
   it can write ANOTHER agent's request directory in the same repo and so ask
   that agent's watchdog to spawn as it. Removing that grant (and the
   spawner-only `PARENTCLAUDE`, `REPOID` and tmux-socket grants) for spawners is
   the follow-up that turns the broker from a convenience into a boundary.
   Retire, merge and rehire no longer need those grants: they go through the
   broker (§4C.7).
2. `worktree:false` agents resolve as callers by process ancestry
   (`ps` must work inside the sandbox); if it does not, `ib new-agent` reports
   the verification error instead of spawning. Even when it does, such an agent
   has no live per-agent watchdog to ask — see §4C.7 limitation 3.
3. The child sandbox preflight (profile lint, port allocation) now runs in the
   unsandboxed watchdog for brokered spawns, so it is no longer subject to the
   nested-sandbox and bind denials above.

### 4C.7 Sandboxed lifecycle commands: the same broker (2026-09-30)

**Problem.** `ib retire <child>` from a sandboxed manager failed with `Could not
prepare retirement: fatal: Unable to read current working directory: Operation
not permitted`. A spawner's profile grants `AGENTDIR`, `WORKTREE`, `GITDIR` and
`REPOAGENTS` (§4C.1) but NOT the main repo root. `prepareAgentRetirement` runs
`git -C <main repo> update-ref ...`; git changes to that directory and then
cannot read it. Reproduced on a throwaway repo under a profile of the same
shape: the three git calls in the child's worktree pass, the main-root call
fails with exactly that text, and the same `update-ref` run in the child's
worktree passes. The teardown that follows has the same problem
(`git -C <main repo> worktree remove` / `branch -D`) and then moves the agent
into `<repo>/.ittybitty/archive`, which no worktree agent's profile grants.
`ib merge <child>` fails the same way, earlier and with a misleading message:
its `git -C <main repo> show-ref` cannot run, so it reports `Branch
'agent/<id>' does not exist`. `ib rehire <child>` never got that far: the
archive is unreadable, so the command reports `Retired agent not found`, and
the PreToolUse hook had already denied it for the same reason (below).
Granting the repo root and the archive to every spawner would widen the sandbox
for all managers, so the command leaves the sandbox instead.

**Design.** The same route as a spawn (§4C.6): the sandboxed command hands the
request to the caller's own unsandboxed watchdog and waits. Queue, file names,
atomic writes, at-most-once handling, result clipping and pruning are the spawn
broker's. `src/lifecycle-broker.ts` adds:

- **Request** — `{v:1, id, op, target, keep?}`, `op` = `retire` | `merge` |
  `rehire`. A request that has an `op` field is a lifecycle request (except
  `op: "ask"`, §4C.8); one without is a spawn.
  `target` must be a plain agent id (it becomes a path segment). `keep` (`ib
  merge --keep`) is accepted for `merge` only. Any other field is rejected — in
  particular there is no way to name a directory.
- **Client** — `routeLifecycleThroughWatchdog`, called from the `retire`,
  `merge` and `rehire` cases in `src/index.ts` after the target is resolved
  (`rehire` takes the id as typed and refuses an invalid one before queuing).
  **Only one kind of caller is routed: a worktree agent inside its own
  itsybitsy sandbox.** For every other caller it returns null and the command
  runs directly, exactly as before:
  - a process that is not sandboxed (`isSandboxedProcess()`);
  - a sandboxed shell that is not, or cannot be shown to be, an agent;
  - a `worktree:false` agent (per-repo coordinator, Claude `--no-worktree`).
    Its profile grants the repo root (its `WORKTREE`), so the direct path works;
    and its per-agent watchdog leaves its loop at once because there is no
    `<agentDir>/repo`, so it has no heartbeat and nobody to serve a request;
  - an agent whose itsybitsy sandbox is off (`meta.sandbox.enabled === false`).
    `isSandboxedProcess()` is still true for a codex agent in that mode — it
    sits in codex's own `workspace-write` sandbox, which grants the git common
    dir and `<repo>/.ittybitty` — and such an agent has no seal to verify.

  This only routes; it grants nothing. A caller that edits its own `meta.json`
  to get the direct path runs the command inside its real sandbox, where it
  fails as before. A routed caller fails at once when the watchdog
  has no fresh heartbeat, writes the request and waits at most **100 seconds**
  (`LIFECYCLE_CLIENT_TIMEOUT_MS` — a teardown removes a whole worktree; the
  value stays under the 120s default tool timeout). On timeout it withdraws an
  unclaimed request; a command the watchdog already started may still finish,
  and the message says so.
- **Server** — `handleLifecycleRequest`, reached from `processSpawnRequests`.
  The requester is the watchdog's own agent, verified against its sealed record
  exactly as for a spawn. **Authorization is applied here, not only in the
  hook:** the watchdog runs the PreToolUse hook's manager rule itself, so only
  the target's manager or spawner — or the repo's coordinator for `retire` and
  `rehire` — passes. The hook alone cannot carry this, because a sandboxed agent
  can write a request file without running `ib`. The target is resolved inside
  the requester's OWN repo only (a sandboxed agent manages agents only in its
  repo, matching the `--repo` refusal for spawns). The order for `retire` and
  `merge` is: parse, verify the requester, resolve the target, refuse a
  self-target, authorize, run the normal `retireAgent()` / `mergeAgent()`. A
  `rehire` has no active target: authorize, then `rehireAgent()`.
- **Nothing rests on an unsealed field of the requester's meta.** `AGENTDIR` is
  a write root for every agent, so every agent can write its own `meta.json`,
  and the seal covers only `agentType`, `canSpawnChildren`, `paths` and
  `sandbox`. Five rules follow:
  1. *The target is a directory entry, not an `id` in a `meta.json`.* For
     `retire` and `merge` the target is resolved before anything else: it must
     be the real directory named exactly `<repo>/.ittybitty/agents/<target>`
     (as `readdir` spells it — a case variant or a symlink does not count),
     and the `meta.json` in it must carry the same id. `meta.id` is unsealed
     too, and `readAllAgents` reports it as the agent's id.
  2. *An agent is never its own target.* The rule reads `manager` from the
     target's `meta.json`; for a self-target that is the requester's own file.
     The comparison is by id and then by resolved directory, because on a
     case-insensitive volume (the macOS default) `Agent-X` opens the directory
     of `agent-x`.
  3. *The rule is called with structured arguments* —
     `checkManagerCommandAccess(op, target, caller, agentsDir, opts)` in
     `src/hooks/agent-path.ts`, the body of `checkIbCommandAccess` — not with a
     synthesized command line. On a command line a target such as `-v` reads as
     a flag and the hook rule makes no decision; here null means "allowed" and
     nothing else, and a command the rule does not gate is denied.
  4. *The rule gets the verified meta* (`opts.callerMeta`) and does not read the
     requester's file a second time, so the coordinator authority is the sealed
     `agentType`, not whatever is on disk a moment after the seal check.
  5. *A rehire is decided from the archive of the requester's repo only*
     (`opts.ownArchiveOnly`). An active `agents/<id>/meta.json` is ignored: a
     spawner could write one.
- **Merge** — the merge is aimed at `<agentDir>/repo`, the requester's own
  worktree. The directory is fixed by the agent's id. It is not taken from the
  request, and not from `meta.worktree`, which is unsealed (the requester could
  otherwise choose the main checkout). It must be a real directory when the
  request is handled; a symlink there is refused. That check is made once,
  before use (limitation 5). The same path is passed as
  `MergeAgentOptions._brokeredCaller.cwd`, which stands in for `process.cwd()`
  inside `mergeAgent` (the own-worktree check and the detached HEAD
  `main`/`master` lookup). The watchdog's own cwd and tmux environment say
  nothing about the requester, so a brokered merge is always an agent merge
  (`--ff-only`, SPEC.md §3.4) without the `isRunningAsAgent` probe.
- **Rehire** — the target is an archive, not an active agent, so no agent is
  looked up; `rehireAgent(id, { repoPath })` searches the requester's repo only
  (a direct `ib rehire` still searches every registered repo). Reconstruction,
  re-seal and the session start all run in the watchdog, as for a brokered
  spawn.
- **The hook defers one case.** The PreToolUse rule authorizes `ib rehire` from
  the archived `meta.json`, and a sandboxed worktree agent cannot list
  `<repo>/.ittybitty/archive`. The rule therefore found nothing and denied every
  rehire — including the agent's own child — before the command could run.
  The hook rule now returns "no decision" for `rehire` when the target
  is not an active agent in the caller's repo AND the process is sandboxed AND
  listing the archive fails with `EPERM`/`EACCES`. That is safe because a
  caller for whom the archive is hidden cannot rehire by itself: either it is
  routed to the watchdog, which applies the full rule unsandboxed, or it runs
  the command directly inside the same sandbox, where `rehireAgent` cannot read
  the archive either. Nothing else changes: an active target is
  still decided from its `meta.json`, `retire`/`merge` of an unknown id are
  still denied, and a sandboxed agent that CAN read the archive (a
  `worktree:false` agent) is still decided by the hook.
- **Old watchdogs** parse every request as a spawn and answer `unsupported
  field 'op'`; the client turns that into "restart this agent so its watchdog
  picks up the feature".

**Verified.** Unit tests (`src/lifecycle-broker.test.ts`), including the real
authorization rule against `meta.json` files on disk; and a live run of the
compiled `ib` as the client inside a deny-default profile of the spawner shape
(no main repo root, no archive), on a throwaway repo with real worktrees,
against the broker code and the real `retireAgent()` as the unsandboxed server.
Under that one profile: the previous binary failed with the text above; the new
binary failed at once with no fresh heartbeat; a target managed by another agent
was refused by the server; the requester itself, with `manager` set to its own
id in its `meta.json`, was refused as a target; and the caller's own child was retired in under a
second, leaving `retirement.json`, `worktree.patch`, the untracked file and the
retained ref in place, the branch deleted and both queue directories empty.
For merge, under the same profile: the previous binary failed with `Branch ...
does not exist`; the new binary was refused for another agent's child; `merge
--keep` fast-forwarded the manager's branch and left the child in place; and a
closing merge fast-forwarded the manager's branch (no merge commit), archived
the child and deleted its branch, with the main checkout untouched.
For rehire: `checkIbCommandAccess`, compiled into a probe and run inside the
profile, denied the caller's own archived child before the change and returns
"no decision" after it, while an active agent of another manager stays denied
there and a stranger's archive stays denied unsandboxed; the previous binary
reported `Retired agent not found`; and the new binary was refused for a
stranger's archive and rebuilt its own child (worktree at the retained HEAD,
branch, committed and untracked files, `manager`) as a stopped agent. **Not
run live:** the session start that follows a rehire. It is the unchanged
`resumeAgent`, and the test stubbed tmux on the server side, so the run ends
with `Resume failed` after the reconstruction. **Unit tests only:** the routing
of the callers that keep the direct path, and the trust rules for a requester
that edits its own `meta.json` (`worktree`, a coordinator `agentType` after the
seal check, a `-v` target, an active record planted over an archive, a symlink
in place of its worktree) — each against files on disk.

**Known limitations.**
1. **The rule trusts the TARGET's word about who manages it.** It reads
   `manager` / `spawned_by` from the target's `meta.json`, and the seal covers
   only `agentType`, `canSpawnChildren`, `paths` and `sandbox`. Two kinds of
   agent can write those fields:
   - *The target itself* — every agent can write its own `meta.json`. So an
     agent can hand itself to ANY other agent in the repo. The rule does not
     ask whether the requester is a spawner, so two cooperating non-spawners
     are enough: X writes `manager: Y`, and Y's watchdog will retire or merge
     X. A merge runs the repository's git hooks outside the sandbox
     (limitation 2) with no real manager in the sequence. One agent alone
     cannot do this: the broker trusts no unsealed field of the REQUESTER's
     own file, and an agent is never its own target (above).
   - *A spawner* — it holds a write grant on `<repo>/.ittybitty/agents`, so it
     can write itself in as the manager of any agent in its repo and then
     retire it, or merge its branch into its own. This is the same grant as
     limitation 1 of §4C.6.

   A rehire has the same input one step removed: it is authorized from the
   ARCHIVED `meta.json` only, and no worktree agent can write the archive — but
   the archive holds a copy of the file the retired agent could write until its
   teardown. A `worktree:false` agent can also write the archive directly (its
   `WORKTREE` is the repo root); it is never a broker requester (no per-agent
   watchdog), but an archive it rewrote is what a later rehire, brokered or
   direct, reads.
   A retirement is recoverable with `ib rehire`; a closing merge is not
   rehirable, but its commits are on the requester's branch. Closing this needs
   a decision: seal `manager` / `spawned_by`, or have the broker serve only
   requesters whose SEALED `canSpawnChildren` is true (which closes the
   non-spawner case and leaves the spawner case).
2. The watchdog runs git in a repository whose git dir the agent can write
   (`GITDIR`), outside the sandbox. This is not new — a brokered spawn already
   runs `git worktree add` there, and every unsandboxed `ib` (the TUI, the
   user) already runs git in that repository — but each brokered command adds
   git calls to that surface. A brokered merge runs `rebase`, `checkout` and
   `merge`, which fire the repository's git hooks and read its git config. A
   non-spawner whose manager merges it can therefore have code it placed in the
   git dir run outside the sandbox. Narrowing what an agent may write under
   `GITDIR` is the fix and is out of scope here.
3. Callers the broker does not serve keep the direct path, unchanged by this
   section, with whatever limits it had. For a sandboxed `worktree:false` agent
   the profile grants the repo root, but a step that needs the tmux server or a
   nested `sandbox-exec` (the session start of a rehire) is not helped. None of
   these direct paths was run live for this section. The brokered
   `ib new-agent` of §4C.6 has the same two gaps and does NOT fall back: a
   sandboxed `worktree:false` agent has no watchdog to ask (its watchdog's exit
   is pinned by a test in `src/lifecycle-broker.test.ts`), and an agent with its
   itsybitsy sandbox off has no seal (from the code; not run).
4. `ib merge-check <child>` is not brokered. From a sandboxed worktree manager
   its `git -C <main repo> show-ref` cannot run, so it reports `Main branch not
   found` (from the code; not run).
5. The merge-directory check is check-then-use. `<agentDir>/repo` is tested
   once with `lstat`; `mergeAgent` then uses the same path in several
   `git -C` calls over some seconds, and `AGENTDIR` is the requester's to
   write. A requester that swaps the directory for a symlink to the main
   checkout after the check gets the `checkout` and the `--ff-only` merge run
   there, and so changes files its profile does not let it write (from the
   code; the race was not run). There is no atomic fix by path. It adds little
   to limitation 2, under which the same requester's git hooks already run
   outside the sandbox during that merge.

### 4C.8 Sandboxed `ib ask`: the same broker (2026-09-30)

**Problem.** `ib ask "question"` from a sandboxed worktree agent did not reach
the user. `askQuestion()` appends the question to
`<repo>/.ittybitty/user-questions.json`. A worktree agent's profile grants
`AGENTDIR`, `WORKTREE`, `GITDIR` and `REPOAGENTS` (§4C.1) — `REPOAGENTS` is
`<repo>/.ittybitty/agents`, not `<repo>/.ittybitty` — so the questions file is
outside its write roots and the write is refused. The notifications that follow
the write (`say`, Telegram) are never reached. A write grant on that file would
let every agent rewrite any pending question in the repo, so the command leaves
the sandbox instead.

**Design.** The same route as a spawn (§4C.6) and a lifecycle command (§4C.7):
the sandboxed command hands the request to the caller's own unsandboxed
watchdog and waits. Queue, file names, atomic writes, at-most-once handling,
result clipping and pruning are the spawn broker's. `src/ask-broker.ts` adds:

- **Request** — `{v:1, id, op:"ask", question}`. In the queue, a request with
  `op: "ask"` is a question, one with any other `op` is a lifecycle request,
  and one without `op` is a spawn. The request carries the question TEXT only.
  Any other field is rejected — there is no way to name an agent, a repo or a
  file, and no way to mark the question as a harness question (SPEC.md §4.2).
  A question over 1 MiB (`SPAWN_MAX_PROMPT_BYTES`) is refused.
- **Client** — `routeAskThroughWatchdog`, called from the `ask` case in
  `src/index.ts` after the question text is known and before any repo lookup.
  It routes the same callers as the lifecycle broker and no others
  (`resolveRoutedCaller` in `src/spawn-broker.ts`, the rule of §4C.7): only a
  worktree agent inside its own itsybitsy sandbox. For every other caller it
  returns null and `ib ask` runs directly, exactly as before. A routed caller
  asks only as itself: `--id` for another agent is refused. It applies the
  top-level rule first (`askTopLevelRefusal`, the function `askQuestion()`
  uses), so a sub-agent gets the "use `ib send <manager>`" hint whatever the
  state of its watchdog; the watchdog's own check is the one that decides. It
  then fails at once
  when the watchdog has no fresh heartbeat, writes the request and waits at
  most **30 seconds** (`SPAWN_CLIENT_TIMEOUT_MS`). On timeout it withdraws an
  unclaimed request; a question the watchdog already took may still reach the
  user, and the message says so.
- **Server** — `handleAskRequest`, reached from `processSpawnRequests`. The
  requester is the watchdog's own agent, verified against its sealed record
  exactly as for a spawn. The watchdog then runs the normal
  `askQuestion(repo, agentId, question)` with its OWN agent id, so the
  top-level rule, the `allowAgentQuestions` check, the stale-question cleanup,
  the `agent.log` line and the notifications (`say`, Telegram) all apply
  unchanged — and the notifications now run outside the sandbox.
- **Old watchdogs** answer `unsupported field 'op'` (no lifecycle broker) or
  `unsupported field 'question'` (lifecycle broker only); the client turns both
  into "restart this agent so its watchdog picks up the feature".

**Verified.** Unit tests only (`src/ask-broker.test.ts`): the parser, the queue
handler with the real `askQuestion()` against files on disk (question recorded
under the requester's id, top-level rule, config check), the client round trip,
and the routing of each caller that keeps the direct path. **Not run live:**
the compiled `ib` inside a real agent profile.

**Known limitations.**
1. The top-level rule reads `manager` from the requester's own `meta.json`,
   which the agent can write and the seal does not cover. A sub-agent that
   removes the field can ask the user. This is the same for a direct `ib ask`;
   the rule is a convention for who talks to the user, not a boundary.
   `askQuestion()` also reads the unsealed `name` from that file and puts it
   in the text for `say` (the name only) and in the Telegram message (the name
   and the question). Both now run outside the sandbox. They are text only:
   `say` gets one argv entry (no shell), and the message is sent as written. So
   the agent chooses the name that the user hears and reads, not only the
   question.
2. The harness question of the session-start hook (SPEC.md §6.3.1, "Size flag")
   is NOT brokered. The hook calls `askQuestion()` in the sandboxed agent
   process, so a sandboxed worktree agent still gets the log line only.
3. `worktree:false` agents and agents with the itsybitsy sandbox off keep the
   direct path (§4C.7 limitation 3). It was not run live for this section. For
   a sandboxed `worktree:false` agent the direct `ib ask` is only partly
   served: its profile grants the repo root, so the question is recorded, but
   no Telegram message goes out. Two causes give that result. The stock
   `_all.md` does not grant `~/.itsybitsy/channels`, so the outbox write is
   refused and `askQuestion()` swallows the error (from the code; not run).
   And every direct `ib ask`, sandboxed or not, exits before its un-awaited
   Telegram write is made (measured in review with a probe run from source; it
   is older than this section and is not changed here). The question shows in
   the QUESTIONS pane only.
4. Requests are handled one at a time per agent, so a question queued behind a
   long brokered merge or teardown can time out on the client while it is
   still queued. It is then withdrawn, and the agent can ask again.

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
raw rules + the config `deny` list last. The root-node read claude needs to
boot comes from `_all.md` too — as of A3 the `sandbox.rawAllow` line
`(allow file-read-data (literal "/"))` (superseding the earlier
`allowRead: ["/"]`) — **that line comes from `_all.md`, not from code** — visible
and user-owned, like every other baseline entry (§4A.7). Nothing is assumed;
everything is tested and then written into a `.md` by the user. This means the
derived spike baseline (findings §4.2) becomes the **initial `_all.md` content**,
NOT a generator constant.

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
   `_all.md`. **A3 adopted the `rawAllow` form:** `_all.md` now drops `/` from
   `allowRead` and carries `(allow file-read-data (literal "/"))` in
   `sandbox.rawAllow`, so the shipped floor grants the root *listing* only, not a
   whole-tree read. Because `resolvePathAccess()` models only the paths table,
   this is the one sanctioned resolver/kernel divergence (§4A.8), proven by the
   LIVE `ls /` vs `ls /Applications` probe.
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

- **Connection-attempt logging.** The proxy is the ONLY component that knows the
  target domain (the in-sandbox CLI reaches it over a localhost CONNECT that
  Seatbelt allows, so a blocked domain produces no kernel denial). Every real
  attempt (the health path is never logged) appends one line to
  `<agentDir>/sandbox-proxy.log` (the `--log` file): `[proxy] allowed`,
  `[proxy] denied … reason="not in allowlist"`, or `[proxy] failed …
  reason="upstream unreachable"`. Allowlist-**denied** attempts ALSO append one
  `[<ISO8601>] [SandboxProxy] denied network-outbound target="host:port"` line to
  the agent's `agent.log` (the `--agent-log` file, wired from the start.sh/
  resume.sh preamble), where `parseDenials` picks it up so it surfaces in the
  DENIALS pane beside the kernel denials (only the `denied` verb matches; any
  other `[SandboxProxy]` line is informational). The target is
  `JSON.stringify`-quoted (mirroring `formatSandboxRecord`) so a crafted CONNECT
  host cannot forge a log line — URL parsing already rejects control characters
  and whitespace in a host, but a literal `"` is a valid host code point, so the
  quoting is load-bearing; IPv6 literals are re-bracketed (`[::1]:443`). Each
  write is a single O_APPEND line and a write failure never breaks the proxied
  connection. The proxy's own stdout/stderr also land in `sandbox-proxy.log`
  through an O_APPEND descriptor the launcher hands the detached child, so a
  startup error or crash trace appends after the records instead of overwriting
  the head of the file. Malformed requests (400/431) carry no target and are not
  logged. `allowed`/`failed` records stay in `sandbox-proxy.log` only — the agent
  log carries denials only. There is no rate limit or dedup on this path (unlike
  the kernel collector's `SandboxOutputBudget`): a client looping on a blocked
  domain writes one line per attempt to both files.

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
- `start.sh` / `resume.sh` builders: under the mandatory contract they always
  wrap the `claude` launch (both setsid + fallback branches) and start the proxy
  first. The wrapped claude launch also gains `--dangerously-skip-permissions`
  (A4 G1, §4B.1) — appended to `claudeArgs` only when the prepared sandbox is
  non-null, so the flag is present exactly when the launch is sandbox-wrapped
  (present iff the kernel prefix is present).
- `teardownAgent` (`ib-commands.ts:365` area): kill the proxy, free the port.
- Codex branch (`codex-spawn.ts`): flip `-s workspace-write` →
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

The sandbox is mandatory: an agent **must not start** unless it is fully in place.
There is no unsandboxed fallback. Preconditions checked at spawn (and resume),
each of which aborts on failure:

- `sandbox-exec` is present and the OS is macOS (else: platform can't sandbox).
- The generated `sandbox.sb` compiles (dry-run / lint the profile before launch).
- The per-agent proxy binds its port successfully.
- (codex) the `-s danger-full-access` flip + proxy env are applied.
- On resume, the frozen metadata must include the top-level `paths` block.
  Metadata written before the `paths:` split is refused; it is never interpreted
  as an empty filesystem allowlist.

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

The resume compatibility guard runs before profile or proxy preparation. It is a
single unified refusal: resume logs a specific fail-hard error and returns
non-zero — leaving the agent stopped, with no `sandbox.sb` written and no proxy
started — whenever the frozen metadata cannot support the mandatory sandbox. That
covers a legacy sandbox policy that predates the mandatory contract (missing or
disabled) and a legacy `meta.json` with no top-level `paths` block. The error
recommends re-deriving the policy with `ib sandbox refresh` (§5.6, from an
unsandboxed session), or otherwise nuking and respawning the agent.

### 5.6 `ib sandbox refresh <id> | --all` (A4 G2)

A running or stopped agent's sandbox + paths policy is **frozen** in `meta.json`
at spawn and replayed verbatim on resume, so an edit to the agent-type `.md`
files does NOT reach an existing agent. `ib sandbox refresh` is the deliberate
re-derivation: it re-runs the same layer merge `newAgent` does —
`mergeSandboxLayerConfigs` over `_all.md` ∪ `_non_coordinator.md` ∪ the type
named in `meta.agentType`, then `canonicalizePathsConfig` — rewrites
`meta.sandbox` (`enabled`/`rawAllow`/`domains`) and `meta.paths`, appends a
`[sandbox refresh] re-derived from agent-type files: <what changed>` line to
`agent.log`, then **pauses (when running) and resumes through the ordinary
resume path** so the NEW frozen block is the one replayed (respawnSelf is the
model). The proxy port/pid are left to resume, which reallocates the port and
clears the stale pid exactly as an ordinary resume does.

- **Refusals.** A **coordinator** is refused (its reset path differs —
  `resetCoordinator` rebuilds `settings.local.json` + hooks from `_all.md` +
  `coordinator.md`, which a sandbox refresh cannot express; the caller is
  pointed at the dashboard R key / `ib resume`). A **missing agent-type file**
  is refused with the type named.
- **`--all`.** Refreshes every agent of the **current repo** whose state is not
  stopped, in id order, one result line per agent, continuing on error;
  coordinators are reported as a skip (not a failure); the command exits
  non-zero if any refresh failed.
- **Fail-hard is inherited from resume.** If the refreshed sandbox cannot be
  established the agent is left stopped with the error already in `agent.log`.
- **Run it from an UNSANDBOXED session.** A sealed record (§4C.3, A4 G3) is
  re-written on every refresh, and its directory is denied to every sandboxed
  agent, so the re-seal only succeeds unsandboxed (a sandboxed spawner routes
  the write through the synchronous tmux helper — see G3).

✅ **Implemented as `refreshAgentSandbox` in `src/ib-commands.ts`, dispatched by
`ib sandbox refresh` in `src/index.ts`.**

## 6. Build phases

> **Historical ledger (§6–§8).** These build phases, resolved decisions, and the
> test matrix were written for the opt-in `sandbox.enabled` design. Entries that
> describe an on/off toggle, `enabled` OR-merge, a `-s workspace-write` fallback,
> a disabled or "byte-identical" launch line, or an "enabled vs disabled" test
> case are **superseded** by the mandatory contract (§1, §4, §5.5): the sandbox is
> always applied, codex is always `-s danger-full-access`, and `enabled` is
> retained only as internal metadata. The path grammar, seal/fail-hard, and
> domain-proxy items remain valid.

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

Each phase: `bun test` green + `bunx tsc --noEmit` clean (AGENTS.md gate), then
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
  `sandbox.rawAllow`. As of A3 the floor no longer lists `/` for reading and
  carries the mandatory root listing as the rawAllow line `(allow file-read-data
  (literal "/"))`, so the sole sanctioned divergence is now live: the resolver
  reports `deny` for a read of `/` while the kernel lists the root node (§4A.8).
- ✅ **`allowedPaths` relationship (Adam, 2026-09-02):** it remains an
  independent legacy hook-layer field until Phase B. Kernel `paths:` never
  derives from it.
- ✅ **A3 floor tightening + spawn-keyed roots (Adam, 2026-09-02).** `_all.md`
  `paths.allowRead` drops `/` and `~` to the verified minimum; the root listing
  moves to the rawAllow line above, and `~` is no longer a read ancestor (a type
  that runs `bunx tsc` on an uninstalled worktree adds `~` itself). The
  `~/.itsybitsy` write floor is `agents`, `teams`, `teams.json`,
  `teams.json.tmp`, and `.teams.lock`; toolchain caches are per-type, never
  `~/Library/Caches` in the baseline. Runtime roots are keyed on the resolved
  `canSpawnChildren` (metaCanSpawnChildren: per-agent meta override, then the
  type): REPOAGENTS is write for a spawner and read for a non-spawner,
  PARENTCLAUDE (`<repo>/.claude`) is a write root only for a spawner, and the
  tmux socket (`/private/tmp/tmux-<uid>`) is denied for a non-spawner and kept
  for a spawner (§4C.3). Resume re-derives the roots from meta, so a
  meta.canSpawnChildren toggle flips exactly those three things. A LIVE boot gate
  proves the floor boots claude (no SIGABRT) (§6, §4A.7).

**RESOLVED EMPIRICALLY:**
1. ✅ Claude Code boots under the tractable `(deny default)` baseline; no
   `(allow default)` fallback was adopted.
2. ✅ The installed Codex uses `danger-full-access` under our wrapper and honors
   the per-agent proxy environment; spawn/resume parity is merged in phase 5.

## 8. Test matrix (MANDATED phase gate — from design review)

`bun test` green + `bunx tsc --noEmit` clean is the AGENTS.md gate, but that
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

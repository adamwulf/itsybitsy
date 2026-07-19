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

### 3.2 The `--effort` feature is the threading template

`effort` was threaded frontmatter → parsed `AgentType` → spawn flag, per memory
[[project_effort_level_feature]]. Its **6 verified touch-points** are the exact
map to follow (all line refs current):

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

⚠️ **Schema is FLAT — ONE level of nesting (R1 fix).** The frontmatter parser
(`parseAgentTypeFile`, `agent-types.ts:66-158`) supports only **one** level of
nesting (a parent object with scalar/list children — exactly how `permissions:`
works). A two-level `sandbox.filesystem.allowRead` would parse **silently into
garbage** (the `filesystem:` key becomes an empty list; `allowRead:` flattens into
the `sandbox` object). So `sandbox:` is a single object whose children are the
scalar `enabled` and the five lists directly (`allowRead`, `allowWrite`, `deny`,
`rawAllow`, `domains`) — NO `filesystem:`/`network:` sub-objects:

⚠️ **NO trailing inline `#` comments.** The parser strips only FULL-LINE comments
(`agent-types.ts:102`); a trailing `# …` reaches the value unstripped, so
`enabled: true  # note` parses to the truthy STRING `"true  # note"` (and
`enabled: false # note` would ALSO be truthy!), and `deny: [...]  # note` loses
its closing `]` and the whole list silently becomes one garbage string — the
exact footgun §4A.2 warns about. Keep comments on their own lines only:

**Everything the sandbox permits — files, commands, and network — is configured
in the `.md` (Adam, 2026-07-18). NOTHING is baked into code.** The complete
surface is five lists under `sandbox:` (the `_all.md` baseline supplies the floor
via union; a type ADDS what it needs):

```yaml
name: netletworker
sandbox:
  enabled: true
  # FILES — readable paths:
  allowRead:  ["~/.config/foo"]
  # FILES — writable paths:
  allowWrite: ["/private/tmp/agent-scratch"]
  # FILES — carve holes inside the allowed set; deny always wins:
  deny:       ["**/.env", "~/.ssh"]
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
  # Fully-open file escape hatch (must be explicit, per Adam): allowRead: ["/"]
```

There is no dimension the sandbox controls that isn't a line here: **files** =
`allowRead`/`allowWrite`/`deny`; **commands/exec + syscalls + the network floor** =
`rawAllow`; **network egress** = `domains`. The user can read, tighten, or remove
any hole.

This is structurally identical to the existing `permissions: {allow, deny}` block,
so it parses today with no parser changes — **provided** the validator rejects a
non-boolean `enabled` and non-array lists (§8 T-2), which also catches an
accidental inline comment. (Alternative considered and rejected: teaching the
parser two-level nesting or inline-comment stripping — more code, and the flat
comment-free form reads fine.) The `AgentType.sandbox` TypeScript type still
models these as grouped fields internally; only the `.md` surface is flat.

Design decisions:

1. **`sandbox.enabled` defaults to `false` → the agent runs fully unsandboxed**
   (exactly today's behavior). This is the ONLY unsandboxed path once the feature
   ships. When `true`, the model is deny-by-default: nothing is reachable but the
   baseline (§4A.7) + the explicit allow lists. There is no "sandbox but
   allow-everything" default — openness is opt-in via `allowRead: ["/"]`.
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
   (`agent-path.ts`) is a deny-by-default *allowlist* at the hook layer **only when
   it is set** — when `allowedPaths` is unset, rule 13 (`agent-path.ts:435-436`)
   is allow-everything, so the hook layer is NOT strict by default. Our sandbox is
   the same allowlist model but kernel-enforced. `sandbox.allowRead`/`allowWrite`
   are the kernel counterpart. If `sandbox` filesystem lists are omitted but
   `allowedPaths` is set, derive the kernel allowlist from `allowedPaths` — and
   since `allowedPaths` is op-agnostic at the hook, the derived kernel config grants
   **both read AND write** for each entry (G-6). If both
   are set, the `sandbox` filesystem lists are authoritative for the kernel and `allowedPaths`
   stays the hook layer; keep them consistent (§4A.1). Document in SPEC §2.
5. **Inheritance → UNION of all `.md` layers (Adam's call).** Final permissions =
   the sum of every layer: `_all.md` ∪ type ∪ any intermediate. **Both** the
   list fields (`domains`, `allowRead`, `allowWrite`, `deny`, `rawAllow`) union
   across the chain — a child can **add** access (union its allow) and/or **narrow** access
   (union its deny). Because deny-wins (§4A.0), a child (or any layer) can never
   re-open what another layer denied. The scalar `enabled` uses **OR-merge** (any
   layer setting `enabled: true` wins), NOT last-non-empty-wins — otherwise a leaf
   type could set `enabled: false` and switch OFF a sandbox that `_all.md` turned
   on, the most total possible "re-open", which contradicts the whole model.
   (Adam authors all type files, so last-wins would be *safe* in practice, but
   OR-merge makes the "a layer can only tighten" invariant hold for `enabled` too.)
   ⚠️ Implementation note: the `permissions` union is a **hand-written special
   case** (`mergeRawFrontmatters` :459-467), not generic machinery — so `sandbox`
   needs analogous **new** merge code (union the five lists incl. `rawAllow`,
   OR-merge `enabled`), modeled on it, not a free reuse.

## 4A. Path pattern format for allow/deny lists (AUTHORITATIVE)

This is the exact, user-facing contract for entries in `sandbox`'s
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

⚠️ **ENTRIES are canonicalized too, not just match targets (G-7).** A `/tmp/x`
entry must compile as `/private/tmp/x`, or it will never match (Seatbelt matches
canonical paths). This must work even for a path that **does not exist yet** (e.g.
a scratch dir the agent will create) — `realpathSync` on a nonexistent path falls
back to the unresolved input, which is the exact gap the existing `allowedPaths`
normalization has (`ib-commands.ts:4511-4516`). The generator must resolve the
longest existing prefix and append the rest, so `/tmp/not-created-yet` still
becomes `/private/tmp/not-created-yet`.

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

### 4A.4 Worked example — deny ALL `.env`, even inside the worktree

```yaml
sandbox:
  enabled: true
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

**Decision (Adam, 2026-07-17, reaffirmed + hardened 2026-07-18): the baseline is
spelled out explicitly in `_all.md`, and the generator bakes in NOTHING.** Not a
"draft 1" convenience — a firm rule: **zero permissions are hardcoded in
`src/sandbox.ts`.** The generator emits only `(deny default)` + exactly what the
merged `.md` config declares. Every allow — including the `(literal "/")` root read
claude needs to boot, and the OS/dylib read paths — is a line in `_all.md` that the
**user** owns and can inspect, tighten, or remove. Nothing is assumed baked-in and
then discovered broken; the user adds permissions as testing shows they're needed.
`_all.md` already merges into every spawned agent (`agent-types.ts` layer files),
so this needs zero new mechanism — every type unions it in for free. There is no
"encode the baseline as a code constant later" step; that would re-introduce baked-in
permissions and is explicitly rejected. So:

- The static OS/runtime paths go in `_all.md`'s `sandbox.allowRead`
  / `sandbox.allowWrite` (and the required domains in `sandbox.domains`). Adam
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
  - the agent's Claude project dir (`~/.claude/projects/<encoded-worktree>`), if
    not expressible as a static parent in `_all.md`.
  These are passed as Seatbelt `-D` params (`WORKTREE`/`AGENTDIR`, `GITDIR`, …) by
  the spawn/resume script, exactly like the reference passes `SECRETS_DIR`.

Candidate static `_all.md` contents (finalize empirically in the phase-1 spike —
the exact set is OS/Claude-version-dependent and MUST be verified, not guessed):

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
   At spawn, the FULLY-RESOLVED merged sandbox config (unioned allow/deny/domains,
   `enabled`) is written to `meta.json`; both `start.sh` and `resume.sh` build the
   profile from that frozen config + the recomputed runtime `-D` params (worktree,
   gitdir). **The proxy port is the ONE deliberately NON-frozen field** — §5.2
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

### 4C.2 Watchdog spawn inheritance (design answer needed, not a spike note)

`ib new-agent` spawns the CHILD's watchdog via `Bun.spawn(["ib","watchdog",id])`
**in the invoking process** (`ib-commands.ts:5190-5196`). If the invoker is a
**sandboxed manager**, the child's watchdog inherits the **manager's** Seatbelt
profile for its whole lifetime — the wrong profile, and the watchdog needs
`tmux send-keys`, cross-agent-dir writes, and process kills that the manager's
profile won't grant. (The child's `claude` itself is fine — it's spawned by the
*unsandboxed* tmux server and then wrapped by its own `start.sh`.) Same inheritance
hits `generatePromptSummary` and `autoAcceptWorkspaceTrust` fired from a sandboxed
invoker. **Design options:** route watchdog spawning through the tmux server
(`tmux run-shell`) so it launches unsandboxed, or have a small `ib` daemon /
coordinator own watchdog spawning. Pick one before phase 3.

### 4C.3 tmux socket = sandbox escape (needs its own decision)

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

### 4C.4 MCP servers

stdio MCP servers are `claude` children → sandboxed. They need their interpreters
(`node`/`bun`/`uv` — `~/.bun`, `~/.nvm`, NOT in the candidate baseline), their
config files, and their **own network** (an MCP server contacting a
non-allowlisted host fails; HTTP/SSE MCP servers too — their traffic falls under
the same domain allowlist). The spike MUST boot an agent with a real MCP server
configured, and `_all.md` must include the interpreter paths. Document that MCP
network egress is subject to the domain allowlist.

### 4C.5 Realistic isolation story (set expectations in §1)

Once 4C.1's requirements land (`~/.itsybitsy/agents/**` write, agents-dir reads,
parent-repo `.ittybitty`, `/usr/local/bin`, `~/.claude` write, tmux socket for
managers), the **kernel layer cannot distinguish "`ib` writing an outbox" from
"the agent writing an outbox"** — Seatbelt is per-path, not per-binary. The honest
isolation story: **kernel = coarse walls + network deny; hook (`agent-path.ts`) =
fine-grained cross-agent etiquette.** Still a big win over today (kernel-blocked
secrets + a real domain allowlist), but §1 should not oversell worker-vs-worker
filesystem isolation.

## 5. Components to build

### 5.1 Profile generator — `src/sandbox.ts` (new)

Pure function: `(SandboxConfig, worktreePath, gitCommonDir, agentDir) → string`
producing the `.sb` text. Writes `sandbox.sb` into the agent dir next to
`start.sh`/`meta.json`. **⚠️ Deny-by-default (Model B) — the profile skeleton is
`(deny default)`, the INVERSE of the reference's `(allow default)`.** SBPL uses
last-matching-rule-wins, so the structure is: deny everything → allow the
baseline+config allowlist → re-deny the config `deny` holes last (so deny wins):

**⚠️ ZERO baked-in permissions (Adam's call, 2026-07-18).** The generator bakes in
**NOTHING** — no allow rule of any kind lives in `src/sandbox.ts`. It is a pure
translator: `(deny default)` + exactly the rules the merged `.md` config declares +
the config `deny` list last. If claude needs `(allow file-read* (literal "/"))` to
boot, **that line comes from `_all.md`, not from code** — visible and user-owned,
like every other baseline entry (§4A.7). Nothing is assumed; everything is tested
and then written into a `.md` by the user. This means the derived spike baseline
(findings §4.2) becomes the **initial `_all.md` content**, NOT a generator constant.

```
(version 1)
(deny default)                                   ;; the ONLY thing the generator emits unconditionally

;; ---- EVERYTHING below is emitted ONLY because the merged .md config declared it ----

;; runtime-injected roots — from the -D params the spawn path computes:
(allow file-read*  (subpath (param "AGENTDIR")))  ;; contains WORKTREE
(allow file-write* (subpath (param "AGENTDIR")))
(allow file-read*  (subpath (param "GITDIR")))
(allow file-write* (subpath (param "GITDIR")))

;; filesystem allows — one per merged allowRead / allowWrite entry (incl. the
;; `(literal "/")` line IF _all.md lists "/" in allowRead; NOT auto-added):
(allow file-read*  (subpath (param "ALLOW_R_0")) ...)
(allow file-write* (subpath (param "ALLOW_W_0")) ...)
;; glob-form allows compile to (regex #"…") instead of (subpath …)

;; syscall / network rules — see the OPEN QUESTION below on how the .md expresses these

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

The generator emits **only** `(version 1)` + `(deny default)` + the merged
`allowRead`/`allowWrite` (→ `file-read*`/`file-write*` rules) + the merged
`rawAllow` lines verbatim + `domains` (→ proxy, not the profile) + the config `deny`
list last. It contains **no allow rule of its own** — not even the network block.
`(version 1)` + `(deny default)` are the only unconditional lines, and neither is a
*hole* (they're the deny-everything floor — the opposite of a permission). Every
**allow** — every actual hole in the sandbox — is a line the user can read in a `.md`.

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

Uses `-D` params for paths (never string-interpolate paths into the profile —
shell-injection surface; the codebase already `shellQuote`s everything). Unit-
testable in isolation (`bun test`), no spawn required.

**⚠️ Spike gotchas (`docs/SANDBOX-SPIKE-FINDINGS.md §7`):**
1. **The spike found claude needs `(allow file-read* (literal "/"))` to boot** —
   it reads the root directory at runtime init; without it, **SIGABRT with ZERO
   output** (aborts before logger init — no stderr, no `--debug-file`). ⚠️ Per
   Adam's zero-baked-in rule this line is **NOT** hardcoded in the generator — if
   required, it lives in `_all.md`'s `allowRead` (as `"/"`), like every other
   entry. AND: the phase-1.5 verification (§6.1.5) must **re-confirm `/` is truly
   mandatory and cannot be narrowed** (e.g. to specific top-level entries) rather
   than assume it — Adam: "test everything, don't assume."
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
   `~/.bun/bin`, dev checkout). The generator must resolve them via `which`/config,
   never hardcode `/usr/local/bin`.

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
    subdomains require an explicit `*.github.com` (or list both). Pick this rule
    and test it — do not silently subtree-match.
  - `*.x.com` = any number of labels under `x.com` or exactly one? Decide (recommend
    "one or more labels", i.e. `a.x.com` and `a.b.x.com` both match) and test.
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
1.5. **Verify the minimal baseline — NOTHING assumed (Adam's "test everything").**
   Before writing any `_all.md` baseline, rigorously establish the *smallest* set
   that actually boots + runs the gate/ib/git, by bisection:
   - **Is `(literal "/")` truly mandatory, or can it be narrowed?** The spike
     asserted `/` is required but derived it in one pass. Re-test: try replacing
     `(literal "/")` with the specific top-level entries claude stats at init
     (bisect the root read); confirm whether a narrower rule boots. If `/` is
     genuinely irreducible, record *why* — don't just assert it.
   - **Minimal syscall set:** individually remove `process*`, `sysctl-read`,
     `file-read-metadata`, `file-ioctl`, `signal`, and narrow `mach-lookup` to the
     curated list (spike §2.4) — keep only what's load-bearing.
   - **Minimal read set:** narrow each `/usr /System /Library …` subpath toward the
     actual dylib/framework set where practical.
   - Output: the **exact** minimal `_all.md` (paths + syscalls + network + domains)
     the user will own, AND the answer to the §5.1 OPEN QUESTION (how the `.md`
     expresses syscall/network rules — A/B/C). Everything the user must add is
     written down; nothing is baked into code.
2. **Filesystem layer + fail-hard (⚠️ merge WITH phase 3 — see R2):** `src/sandbox.ts`
   generator + `sandbox.enabled` + flat `sandbox` frontmatter (R1), wrap
   spawn+resume, §5.5 precondition checks (no unsandboxed fallback), persist
   resolved config to meta.json. **A sandbox-enabled agent has NO route to
   `api.anthropic.com` until the proxy (phase 3) exists — the kernel can't do
   domains, egress is binary-blocked. So `sandbox.enabled: true` must NOT be usable
   on a live agent until phases 2+3 land together (R2).** Tests + tsc.
3. **Network layer:** per-agent Bun proxy + domain allowlist + port in meta.json +
   lifecycle (start/resume/teardown + EXIT trap + watchdog health-check, §5.2),
   `_all.md` domain baseline. Merge together with phase 2 (R2).
   **⚠️ Design decision REQUIRED before this phase (§4C.2): watchdog spawn
   inheritance** — a sandboxed manager's `Bun.spawn(["ib","watchdog",id])`
   (`ib-commands.ts:5190`) makes the child's watchdog inherit the manager's
   profile. Pick the fix (route via tmux `run-shell`, or an `ib` daemon owns
   watchdog spawning) before wiring the wrap into a spawning agent.
4. **Inheritance (union+OR-merge) + validation + `_all.md` interaction + §4C
   baseline (ib paths, `~/.itsybitsy/agents/**` write, tmux-socket scoping)**,
   SPEC.md §2/§7 updates, `docs/agent-types/*.md` doc updates.
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
  denied. Modeled on (not free reuse of) the existing `permissions` merge
  (`agent-types.ts:459-483`). The scalar `enabled` uses **OR-merge** (any layer
  `true` wins) — NOT last-non-empty-wins — so a leaf type can't switch off a
  sandbox a parent layer turned on (§4 decision 5, §8C).
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

## 8. Test matrix (MANDATED phase gate — from design review)

`bun test` green + `bunx tsc --noEmit` clean is the CLAUDE.md gate, but that
gates nothing *specific*. Phases 2–4 must be held to the concrete matrix below —
each bullet is at least one test. The profile generator, glob compiler, merge, and
proxy are all pure/unit-testable with no spawn required.

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
- `(deny default)` emitted FIRST; ALL deny rules emitted AFTER every allow
  (last-match-wins is the entire §4A.0 guarantee); network block present;
  localhost-only exits.
- Paths travel ONLY via `-D` params — assert NO user-controlled string is
  interpolated into profile text. Injection test: a path containing
  `")(allow default)(` must appear nowhere in the emitted `.sb`.
- `allowRead:["/"]` full-open form; empty lists; glob-form allow compiles to
  `(regex …)` under the correct op (`file-read*` vs `file-write*`).

**C. Config resolution + merge:**
- Union across `_all.md` + intermediate + type for all FIVE lists (`allowRead`,
  `allowWrite`, `deny`, `rawAllow`, `domains`), deduped; deny-wins when the same
  path is in `allowWrite` AND `deny`; `enabled` OR-merge (leaf `false` does NOT
  switch off a floor `true` — §4 decision 5).
- **`rawAllow` emission + ordering:** every merged `rawAllow` line appears verbatim
  in the generated `.sb`, in the allow section BEFORE the config `deny` list (so
  config denies still win); a `rawAllow` `(deny network*)` followed by a localhost
  re-allow works via SBPL last-match-wins.
- `sandbox` omitted + `allowedPaths` set → derived config; both set → `sandbox`
  authoritative. ⚠️ `allowedPaths` merges by REPLACE (`SCALAR_KEYS`,
  `agent-types.ts:422`) while `sandbox` lists UNION — pin which semantics a
  derived config inherits.
- Frontmatter parse round-trip: flat `sandbox:` block (R1) — block lists, inline
  arrays, comments; assert NO silent flattening.
- **T-2 — validator REJECTION (load-bearing; guards the §4 inline-comment footgun):**
  spawn is refused when `enabled` is non-boolean (crucially incl. a trailing-comment
  string like `"true  # note"`, which is truthy and would otherwise silently pass),
  when any of `allowRead`/`allowWrite`/`deny`/`rawAllow`/`domains` is not an array,
  or when an unknown key appears inside `sandbox:`. Also reject a `rawAllow` entry
  that isn't a balanced `(...)` s-expression, and lint-warn on catch-all
  `rawAllow` lines (`(allow default)`, `(allow file-read*)` with no filter) that
  would defeat Model B. This is the guard §4 relies on to call the flat schema
  safe — assert each case refuses/warns with a specific message.

**D. Hook cascade (`agent-path.ts`):**
- Sandbox-deny (new rule ~6.5) fires BEFORE the worktree allow (rule 7, :391) —
  the §4A.4 worked example as a test: worktree `.env` is denied.
- Non-matching denies leave rules 7/8/9 outcomes unchanged.
- Glob deny at the hook layer needs a real glob matcher — `isInAllowedPaths` is
  prefix-only (`:99`); use `Bun.Glob`. Test glob denies actually match.

**E. Meta persistence + resume parity:**
- Fully-resolved `sandbox` block round-trips `writeMetaJsonAtomic` → `readAgentMeta`
  — **declare the field in `AgentMeta` and add coercion** (unlike `allowedPaths`,
  which is written at `ib-commands.ts:4544` but undeclared in `agents.ts:50-92` —
  don't repeat that gap).
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

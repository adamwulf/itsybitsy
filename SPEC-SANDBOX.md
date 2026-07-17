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
| Single hardcoded `sandbox.sb`, allow-everything-except | **Generated per-agent** profile from frontmatter |
| One `-D` param: `SECRETS_DIR` (deny one path) | Arbitrary allow/deny path lists |
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
  functional). On Linux/other, sandbox config must **degrade to a no-op with a
  warning**, never silently claim enforcement. (itsybitsy is already a
  macOS/tmux-centric tool, so this matches the platform reality.)

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
# after (sandbox enabled)
setsid sandbox-exec -f "$AGENT_DIR/sandbox.sb" \
  -D "WORKTREE=$WORKTREE" -D "GITDIR=$GITDIR" \
  env http_proxy=http://localhost:$PORT https_proxy=http://localhost:$PORT \
      HTTP_PROXY=... HTTPS_PROXY=... no_proxy=localhost,127.0.0.1,::1 \
      NODE_OPTIONS="--use-env-proxy" \
  claude --session-id "$UUID" $ARGS "$(cat $PROMPT)" &
```

**⚠️ PID / watchdog hazard (the #1 spike item).** Today `CLAUDE_PID=$!`
(`:5046` spawn / `:1602` resume) captures the `claude` pid and feeds two
consumers: the meta.json `claude_pid` write and the watchdog reaper
`reapOrphanedClaude` (`src/agents.ts` ~:2013-2021). If we prefix `sandbox-exec`,
`$!` becomes the **`sandbox-exec`** pid, not `claude`'s. Two things to verify in
the spike:

1. **Is `sandbox-exec`'s pid the one we want to kill/reap?** Killing
   `sandbox-exec` should tear down its child `claude` (it's the process-group
   parent), so this may be *fine* or even *better* (kills the whole sandbox). But
   `reapOrphanedClaude` and the `pgrep … -f "claude"` discovery
   (`src/agent-lifecycle.ts:510`) must be checked: does the watchdog match on the
   process **named** claude (still present as a child under sandbox-exec) or on
   the pid stored in meta? A mismatch = mis-detected state.
2. If the stored pid must stay `claude`'s (not sandbox-exec's), capture it
   differently (e.g. `pgrep -P $!` after launch) rather than `$!`.

**This must be resolved before committing to the design.**

## 4. Proposed frontmatter schema

```yaml
name: netletworker
sandbox:
  enabled: true              # default false → today's unsandboxed behavior
  filesystem:
    # reuse allowedPaths semantics; worktree + git-common-dir always allowed
    allowRead:  ["~/.config/foo"]
    allowWrite: ["/tmp/agent-scratch"]
    deny:       ["~/.ssh", "~/.aws"]   # deny wins over allow
  network:
    mode: allowlist          # allowlist | blocklist | off (kernel blocks all egress except proxy)
    domains: ["api.anthropic.com", "github.com", "*.githubusercontent.com"]
```

Design decisions:

1. **`sandbox.enabled` defaults to `false`.** Zero behavior change for every
   existing agent type until a type opts in. This is mandatory — a sandbox that
   breaks `git`, `claude`'s own telemetry, or MCP servers by default would make
   the tool unusable.
2. **`api.anthropic.com` (and Claude's required hosts) must be reachable** or the
   agent can't talk to the model at all. When `sandbox.enabled` and network is
   restrictive, **auto-inject the Claude/Anthropic control-plane domains** into
   the allowlist (statsig, sentry, anthropic API, the model gateway). Make this
   an overridable constant, not something each `.md` must remember.
3. **Filesystem reuses `allowedPaths`**: if `sandbox.filesystem` is omitted but
   `allowedPaths` is set, the seatbelt profile is derived from `allowedPaths`
   (kernel-enforce what the hook already advises). If both are set,
   `sandbox.filesystem` is the authoritative superset for the kernel layer while
   `allowedPaths` remains the hook layer. Document the relationship in SPEC §2.
4. **Inheritance (needs a deliberate, mixed rule).** ⚠️ A nested `sandbox:`
   object would, if handled naively, merge like `permissions` — **union across
   the chain** (`mergeRawFrontmatters` :459-467) — which is right for the
   **list** fields (`domains`, path lists: union across `_all.md` → type) but
   **wrong for the scalars** (`enabled`, `network.mode`: those need
   last-non-empty-wins, like `model`/`effort` at :415-434). So `sandbox` is
   neither a pure `permissions`-style nor a pure scalar merge — it's a
   **per-subfield mix**. This must be implemented explicitly in the merge logic
   (`src/agent-types.ts:459-483`), not by dropping the object into either
   existing bucket. Security note: for a *sandbox*, union-on-`domains` means a
   child can only ever **widen** the allowlist inherited from `_all.md`, never
   narrow it — decide whether that's the intended trust model (it likely is:
   `_all.md` sets a floor, types add to it).

## 5. Components to build

### 5.1 Profile generator — `src/sandbox.ts` (new)

Pure function: `(SandboxConfig, worktreePath, gitCommonDir, agentDir) → string`
producing the `.sb` text. Writes `sandbox.sb` into the agent dir next to
`start.sh`/`meta.json`. Mirrors the reference `sandbox.sb` shape:

```
(version 1)
(allow default)
(deny network*)
(allow network-outbound (literal "/private/var/run/mDNSResponder"))
(allow network-outbound (remote unix-socket))
(allow network-outbound (remote ip "localhost:*"))
(allow network-inbound (local ip "localhost:*"))
;; filesystem denies from config (deny wins)
(deny file-read*  (subpath (param "DENY_0")) ...)
(deny file-write* (subpath (param "DENY_0")) ...)
```

Uses `-D` params for paths (never string-interpolate paths into the profile —
shell-injection surface; the codebase already `shellQuote`s everything). Unit-
testable in isolation (`bun test`), no spawn required. Note: the reference
profile is `(allow default)` then carve-outs; an allowlist-of-writable-paths
model (deny-write-default, allow specific) is a bigger profile — start with the
reference's allow-default-deny-secrets shape and iterate.

### 5.2 Domain proxy — `src/sandbox-proxy.ts` + lifecycle

- Adopt the reference's `proxy.py` model but **allowlist-aware** and reading a
  **per-agent** domain file (e.g. `agentDir/sandbox-domains.txt`), or run one
  shared proxy that maps the inbound connection → agent → its allowlist. **Open
  question (§7): one shared proxy vs one-per-agent.** A shared proxy on a fixed
  port is simpler to manage but must identify which agent a connection belongs
  to (hard over plain HTTP CONNECT). One-proxy-per-agent on an allocated port is
  cleaner isolation but adds N processes + port allocation. **Recommendation:
  one proxy per agent, port recorded in meta.json**, lifecycle tied to the agent
  (started by `start.sh`/`resume.sh`, killed in `teardownAgent`).
- Prefer a Bun implementation (`Bun.serve` / raw TCP for CONNECT) over shipping a
  Python dependency — the project is Bun-first (CLAUDE.md) and the `ib` binary is
  self-contained; a Python `proxy.py` would break `bun build --compile`.
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

## 6. Build phases

1. **Spike (blocking):** Wrap one real claude spawn in `sandbox-exec -f` by hand
   with the reference profile; confirm (a) claude still starts, (b) `$!`/`pgrep`
   PID discovery + watchdog still work, (c) git operations in the worktree
   succeed, (d) `api.anthropic.com` reachable only through the proxy. **If PID
   discovery or watchdog breaks under sandbox-exec, the whole design changes.**
2. **Filesystem layer:** `src/sandbox.ts` generator + `sandbox.enabled` +
   `sandbox.filesystem` frontmatter, wrap spawn+resume, no network yet
   (kernel blocks egress, proxy allowlists nothing but Anthropic). Tests + tsc.
3. **Network layer:** Bun proxy + allowlist + per-agent port + lifecycle.
4. **Inheritance + validation + `_all.md` interaction**, SPEC.md §2/§7 updates,
   `docs/agent-types/*.md` doc updates.
5. **Codex parity** (optional): network layer for codex agents.
6. **Dashboard indicator** (optional).

Each phase: `bun test` green + `bunx tsc --noEmit` clean (CLAUDE.md gate), then
a review cycle (2 worker reviewers) before merge.

## 7. Open questions for Adam

1. **Proxy topology:** one shared proxy (simpler, harder to attribute
   connections per-agent) vs one proxy per agent (cleaner, more processes).
   Recommendation: per-agent.
2. **Bun-native proxy vs vendoring `proxy.py`:** Bun keeps the binary
   self-contained; recommend Bun.
3. **Default-allowed domains:** confirm the exact Anthropic/Claude Code control-
   plane host list to auto-allow (API, gateway, statsig, sentry) so sandboxed
   agents can still run at all.
4. **Codex scope:** filesystem is already sandboxed for codex; do we also want
   the domain-allowlist network layer for codex agents in v1, or defer?
5. **Failure mode:** if `sandbox-exec` is unavailable or a profile fails to
   compile, do we **refuse to spawn** (fail-closed, safest) or **spawn
   unsandboxed with a loud warning** (fail-open, more usable)? Recommend
   fail-closed when `sandbox.enabled: true` — an agent that thinks it's
   sandboxed but isn't is the dangerous case.
6. **Existing `allowedPaths` relationship:** confirm the §4.3 plan (sandbox
   filesystem derives from / supersedes `allowedPaths`) rather than introducing a
   parallel, conflicting list.

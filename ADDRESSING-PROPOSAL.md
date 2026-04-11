# Inter-Agent Addressing Strategies for itsybitsy

## Problem Statement

itsybitsy has a two-tier coordinator system with three kinds of targets:

| Target | Current ID | Example |
|--------|-----------|---------|
| System coordinator | (no agent ID — uses `ib inbox`) | `coordinator` |
| Per-repo coordinator | repo basename | `itsybitsy`, `muse-ios` |
| Regular agent | `agent-<hex>` or custom name | `agent-a1b2c3d4`, `my-refactor` |

The current approach uses flat ID matching across all repos with a special-case for `ib send coordinator`. This gets confusing when:
- A repo name could collide with an agent name
- An agent in repo A wants to message an agent in repo B
- Prefix matching creates ambiguity (repo named `agent` vs `agent-a1b2c3d4`)

Below are five addressing strategies. For each, the five canonical cases are:

1. **SYS** — Send to system coordinator
2. **OWN-COORD** — Worker sends to its own repo's coordinator
3. **OTHER-COORD** — Agent sends to another repo's coordinator
4. **CROSS-AGENT** — Agent sends to an agent in another repo
5. **SAME-AGENT** — Agent sends to an agent in the same repo

---

## Strategy A: Scoped Paths (`repo:agent`)

**Syntax**: `ib send <target> "msg"` where target is `[repo:]id`

| Case | Syntax | Notes |
|------|--------|-------|
| SYS | `ib send coordinator "msg"` | Reserved keyword, unchanged |
| OWN-COORD | `ib send :coordinator "msg"` | Bare `:coordinator` = "coordinator of my repo" |
| OTHER-COORD | `ib send muse-ios:coordinator "msg"` | Explicit repo scope |
| CROSS-AGENT | `ib send muse-ios:agent-a1b2 "msg"` | Explicit repo scope |
| SAME-AGENT | `ib send agent-a1b2 "msg"` | No prefix = search own repo first, then all |

**Resolution rules**:
1. `coordinator` (bare, no colon) → system coordinator (always)
2. `:coordinator` → per-repo coordinator of sender's own repo
3. `<repo>:coordinator` → per-repo coordinator of named repo
4. `<repo>:<id>` → agent `<id>` in named repo (exact then prefix match)
5. `<id>` (no colon) → search sender's own repo first; if not found, search all repos; error if ambiguous

**Session-start instructions for each role**:
- **Worker**: `ib send :coordinator "msg"` to reach your repo coordinator. `ib send coordinator "msg"` for system coordinator.
- **Per-repo coordinator**: `ib send coordinator "msg"` for system coordinator. `ib send <id> "msg"` for own agents. `ib send other-repo:coordinator "msg"` for cross-repo.
- **System coordinator**: `ib send <repo>:coordinator "msg"` for any repo coordinator. `ib send <repo>:<id> "msg"` for any agent.

**Pros**:
- Clear namespace separation — no collisions possible
- `:coordinator` is terse for the most common case (worker → own coordinator)
- Colon separator is familiar (Docker, Kubernetes, Git remotes)
- Unscoped IDs still work for the simple/common case (same repo)

**Cons**:
- `:coordinator` leading-colon syntax is slightly unusual
- Agents need to know the repo name to do cross-repo messaging
- Two meanings of `coordinator`: bare = system, after colon = per-repo

---

## Strategy B: Hierarchical Slash Paths (`repo/agent`)

**Syntax**: `ib send <target> "msg"` where target is `[repo/]id`

| Case | Syntax | Notes |
|------|--------|-------|
| SYS | `ib send /coordinator "msg"` | Leading slash = system level |
| OWN-COORD | `ib send coordinator "msg"` | Bare `coordinator` = own repo's coordinator |
| OTHER-COORD | `ib send muse-ios/coordinator "msg"` | Repo-qualified |
| CROSS-AGENT | `ib send muse-ios/agent-a1b2 "msg"` | Repo-qualified |
| SAME-AGENT | `ib send agent-a1b2 "msg"` | Unqualified = own repo first |

**Resolution rules**:
1. `/coordinator` → system coordinator (leading slash = root/system scope)
2. `coordinator` (bare, no slash) → per-repo coordinator of sender's own repo
3. `<repo>/coordinator` → per-repo coordinator of named repo
4. `<repo>/<id>` → agent in named repo
5. `<id>` (no slash) → if `coordinator`, own repo coordinator; else search own repo first, then all

**Session-start instructions for each role**:
- **Worker**: `ib send coordinator "msg"` to reach your repo coordinator. `ib send /coordinator "msg"` for system coordinator.
- **Per-repo coordinator**: `ib send /coordinator "msg"` for system coordinator. `ib send <id> "msg"` for own agents. `ib send other-repo/coordinator "msg"` for cross-repo.
- **System coordinator**: `ib send <repo>/coordinator "msg"` for any repo coordinator. `ib send <repo>/<id> "msg"` for any agent.

**Pros**:
- Filesystem-like mental model — intuitive for developers
- `coordinator` (bare) being the own-repo coordinator is natural for workers (most common message direction)
- Slash is a natural hierarchy separator

**Cons**:
- `/coordinator` with leading slash looks like a filesystem path, could confuse shell escaping
- `coordinator` now means the per-repo coordinator, not the system coordinator — this is a **breaking change** from current behavior where `ib send coordinator` goes to the system coordinator
- LLM agents might produce `ib send /coordinator` when they mean their repo coordinator (slash vs no-slash is subtle)

---

## Strategy C: `@` Mentions (like chat systems)

**Syntax**: `ib send <target> "msg"` where target uses `@` for scoping

| Case | Syntax | Notes |
|------|--------|-------|
| SYS | `ib send @system "msg"` | `@system` is the reserved system coordinator name |
| OWN-COORD | `ib send @coordinator "msg"` | `@coordinator` = own repo's coordinator |
| OTHER-COORD | `ib send @muse-ios "msg"` | Repo name = that repo's coordinator |
| CROSS-AGENT | `ib send agent-a1b2@muse-ios "msg"` | `id@repo` for cross-repo agent |
| SAME-AGENT | `ib send agent-a1b2 "msg"` | No `@` = same-repo agent lookup |

**Resolution rules**:
1. `@system` → system coordinator (reserved)
2. `@coordinator` → per-repo coordinator of sender's own repo
3. `@<repo-name>` → per-repo coordinator of named repo
4. `<id>@<repo>` → specific agent in named repo
5. `<id>` (no @) → search own repo first, then all repos

**Session-start instructions for each role**:
- **Worker**: `ib send @coordinator "msg"` to reach your repo coordinator. `ib send @system "msg"` for system coordinator.
- **Per-repo coordinator**: `ib send @system "msg"` for system coordinator. `ib send <id> "msg"` for own agents. `ib send @other-repo "msg"` for cross-repo coordinator.
- **System coordinator**: `ib send @<repo> "msg"` for any repo coordinator. `ib send <id>@<repo> "msg"` for any agent.

**Pros**:
- `@` is universally understood as "address/mention" (Slack, GitHub, email)
- `@coordinator` and `@system` are very readable
- `@repo-name` to reach that repo's coordinator is elegant and terse
- LLM agents will likely produce correct syntax naturally (@ mentions are in training data)

**Cons**:
- Shell quoting: `@` is safe in bash but `ib send @system "msg"` could look like it needs quoting to nervous users
- `<id>@<repo>` reads backwards (agent at repo) compared to `<repo>/<id>` (repo then agent)
- Requires learning that `@repo-name` means coordinator, not "any agent in that repo"
- Cross-repo agent addressing (`agent-a1b2@muse-ios`) is the least common case but has the most unusual syntax

---

## Strategy D: Implicit Context + Explicit Override (`--repo` flag)

**Syntax**: `ib send <id> "msg"` with optional `--repo <name>` flag

| Case | Syntax | Notes |
|------|--------|-------|
| SYS | `ib send coordinator "msg"` | Reserved keyword, unchanged |
| OWN-COORD | `ib send coordinator --local "msg"` | `--local` = own repo, not system |
| OTHER-COORD | `ib send coordinator --repo muse-ios "msg"` | Explicit repo |
| CROSS-AGENT | `ib send agent-a1b2 --repo muse-ios "msg"` | Explicit repo |
| SAME-AGENT | `ib send agent-a1b2 "msg"` | No flag = search all repos |

**Resolution rules**:
1. `coordinator` without `--local`/`--repo` → system coordinator
2. `coordinator --local` → per-repo coordinator of sender's repo
3. `coordinator --repo X` → per-repo coordinator of repo X
4. `<id> --repo X` → agent in repo X
5. `<id>` (no flags) → search all repos, error if ambiguous

**Session-start instructions for each role**:
- **Worker**: `ib send coordinator --local "msg"` to reach your repo coordinator. `ib send coordinator "msg"` for system coordinator.
- **Per-repo coordinator**: `ib send coordinator "msg"` for system coordinator. `ib send <id> "msg"` for own agents.
- **System coordinator**: `ib send coordinator --repo <name> "msg"` for repo coordinators. `ib send <id> --repo <name> "msg"` for agents.

**Pros**:
- Backward compatible — `ib send coordinator` still means system coordinator
- No new syntax characters (no `:`, `/`, `@`)
- Explicit flags are unambiguous
- Easy to explain: "add `--repo X` to target a specific repo"

**Cons**:
- Verbose — `ib send coordinator --local "msg"` is wordy for the most common worker→coordinator case
- `--local` is a new concept that only applies to `coordinator`
- Flag position matters (message must come after all flags or use `--`)
- LLM agents are more likely to get flag ordering wrong or forget `--local`
- Flags feel heavy for something that should be lightweight addressing

---

## Strategy E: Tiered Names with `^` for "up" (relative addressing)

**Syntax**: `ib send <target> "msg"` where `^` means "my manager/coordinator"

| Case | Syntax | Notes |
|------|--------|-------|
| SYS | `ib send ^^ "msg"` | Two levels up = system coordinator |
| OWN-COORD | `ib send ^ "msg"` | One level up = own repo coordinator |
| OTHER-COORD | `ib send muse-ios "msg"` | Repo name = that repo's coordinator |
| CROSS-AGENT | `ib send muse-ios/agent-a1b2 "msg"` | Slash for cross-repo |
| SAME-AGENT | `ib send agent-a1b2 "msg"` | Bare ID = same repo |

**Resolution rules**:
1. `^^` → system coordinator (two levels up from worker)
2. `^` → sender's manager (which is the per-repo coordinator for direct children)
3. `<repo-name>` (matches a registered repo) → that repo's per-repo coordinator
4. `<repo>/<id>` → specific agent in named repo
5. `<id>` (no special prefix, not a repo name) → search own repo first, then all

**Session-start instructions for each role**:
- **Worker**: `ib send ^ "msg"` to reach your manager. `ib send ^^ "msg"` for system coordinator.
- **Per-repo coordinator**: `ib send ^ "msg"` for system coordinator. `ib send <id> "msg"` for own agents.
- **System coordinator**: `ib send <repo> "msg"` for repo coordinators. `ib send <repo>/<id> "msg"` for agents.

**Pros**:
- `^` for "up" is intuitive (git uses `^` for parent)
- Workers don't need to know their coordinator's name — just `^`
- Works naturally with the hierarchy (worker → coordinator → system coordinator)
- Very terse for the common case

**Cons**:
- `^^` is fragile — what if hierarchy depth changes? A worker under a manager under a coordinator would need `^^^`
- `^` means "manager," not specifically "coordinator" — different semantics if manager hierarchy changes
- Shell quoting: `^` might need quoting in some shells
- Repo name as bare word conflating with coordinator is implicit — `ib send muse-ios` meaning "muse-ios's coordinator" requires knowing muse-ios is a repo
- LLM agents may not reliably count `^` levels

---

## Comparison Matrix

| Criterion | A (colon) | B (slash) | C (@) | D (flags) | E (caret) |
|-----------|-----------|-----------|-------|-----------|-----------|
| Terse common case | Good (`:coordinator`) | Best (`coordinator`) | Good (`@coordinator`) | Poor (`--local`) | Best (`^`) |
| Cross-repo clarity | Best (`repo:id`) | Good (`repo/id`) | OK (`id@repo`) | Good (`--repo`) | Good (`repo/id`) |
| No ambiguity | Best | Good | Good | Best | Poor |
| Backward compat | Good | Poor | Good | Best | Poor |
| LLM-friendly | Good | Good | Best | Poor | Poor |
| Human-friendly CLI | Good | Good | Best | Good | Good |
| Shell-safe | Best | OK | Good | Best | Poor |
| Collision-proof | Best | Good | Good | Best | OK |

## Recommendation

**Strategy A (Scoped Paths with colon)** or **Strategy C (@ Mentions)** are the strongest options.

**Strategy C** wins on LLM-friendliness and human intuitiveness — `@coordinator`, `@system`, and `@muse-ios` read like natural language. The `@` symbol is universally understood as addressing. However, the `id@repo` ordering for cross-repo agents feels backwards.

**Strategy A** wins on technical cleanliness and collision avoidance — the `repo:id` namespacing is unambiguous and the colon separator has precedent in Docker, Kubernetes, and Git. The `:coordinator` shorthand is slightly unusual but learnable.

Either would be a significant improvement over the current flat-ID + special-case-coordinator approach.

### Hybrid Option (A+C): Best of both

A practical hybrid: use `@` for well-known targets and `:` for scoping:

| Case | Syntax |
|------|--------|
| SYS | `ib send @system "msg"` |
| OWN-COORD | `ib send @coordinator "msg"` |
| OTHER-COORD | `ib send @muse-ios "msg"` |
| CROSS-AGENT | `ib send muse-ios:agent-a1b2 "msg"` |
| SAME-AGENT | `ib send agent-a1b2 "msg"` |

Rules: `@system` = system coordinator. `@coordinator` = own repo coordinator. `@<repo>` = that repo's coordinator. `<repo>:<id>` = cross-repo agent. `<id>` = same-repo agent. This combines the readability of `@` for coordinators with the precision of `:` for cross-repo agent addressing.

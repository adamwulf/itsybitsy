# Inter-Agent Messaging: Addressing Scheme Proposals

## Current State (SPEC.md §12.3.1)

itsybitsy has a **flat ID matching system** using partial matching across all repos:
- System coordinator: no agent ID, can receive via `ib inbox` only
- Per-repo coordinators: agent ID = repo basename (e.g., `itsybitsy`, `muse-ios`)
- Regular agents: agent ID = `agent-<8-hex>` or custom names

**Current approach**: `ib send <target-id> "message"` uses **prefix/substring matching** against agent directories. Per-repo coordinators naturally work because their IDs are repo basenames.

**The problem**: Flat matching gets confusing when:
- A repo is named `agent` (shadows `agent-*` prefix matching)
- Multiple repos have agents (ambiguity if names overlap)
- LLM agents generate addressing commands (need unambiguous, deterministic rules)

---

## Five Addressing Schemes

### Scheme 1: Hierarchical Path Syntax (`repo:agent`)

**Syntax for all 5 cases:**

```
1. Send to system coordinator
   ib send @ "message"
   
2. Send to own repo's coordinator (from worker in itsybitsy repo)
   ib send @self "message"
   
3. Send to another repo's coordinator (from agent in muse-ios repo)
   ib send @itsybitsy "message"
   
4. Send to agent in another repo (from agent in muse-ios repo)
   ib send itsybitsy:agent-a1b2c3d4 "message"
   
5. Send to agent in same repo (from agent in itsybitsy repo)
   ib send agent-a1b2c3d4 "message"
   (or explicit: ib send :agent-a1b2c3d4 "message")
```

**Resolution rules:**
- `@` alone = system coordinator (special)
- `@self` = current repo's coordinator (only valid when called from within repo)
- `@<repo>` = per-repo coordinator by repo name
- `<repo>:<agent>` = agent in named repo (colon separates repo from agent)
- `<agent>` or `:<agent>` = agent in current repo
- Partial matching: allowed within the specified scope (repo:* for agents in repo, @* for coordinators)

**Session-start instructions for different roles:**

*Manager*:
```
| `ib new-agent --worker "task"` | Spawn a worker sub-agent |
| `ib send <id> "msg"` | Send to agent in same repo |
| `ib send @self "msg"` | Send to your repo's coordinator |
```

*Worker*:
```
| `ib send <manager-id> "msg"` | Send to your manager |
| `ib send @ "msg"` | Send to system coordinator |
```

*Per-repo Coordinator*:
```
| `ib send <worker-id> "msg"` | Send to a worker agent |
| `ib send @ "msg"` | Send to system coordinator |
| `ib send @<other-repo> "msg"` | Coordinate with other repo's coordinator |
```

**Pros:**
- Unambiguous: explicit scope prevents collisions
- Composable: clear mental model (`repo:agent` is "agent in repo")
- LLM-friendly: rules are easy to explain and unambiguous
- Backward-compatible: bare `<agent>` still works for same-repo

**Cons:**
- Requires parsing `:` and `@` in command line (shell escaping concern)
- More typing for common cases (cross-repo adds `:` notation)
- `@self` requires CWD context; ambiguous when called from non-agent context
- Partial matching with `:` could be confusing (does `it:agent` prefix-match across repos?)

---

### Scheme 2: DNS-Style FQDN (`agent@repo`)

**Syntax for all 5 cases:**

```
1. Send to system coordinator
   ib send coordinator@system "message"
   
2. Send to own repo's coordinator (from worker in itsybitsy repo)
   ib send coordinator@self "message"
   
3. Send to another repo's coordinator (from agent in muse-ios repo)
   ib send coordinator@itsybitsy "message"
   
4. Send to agent in another repo (from agent in muse-ios repo)
   ib send agent-a1b2c3d4@itsybitsy "message"
   
5. Send to agent in same repo (from agent in itsybitsy repo)
   ib send agent-a1b2c3d4 "message"
   (coordinator@self is implied if called from coordinator)
```

**Resolution rules:**
- `<name>@<realm>` = FQDN addressing (agent name @ repo name or `system`)
- `<name>` = local scope (current repo)
- `coordinator@system` = system coordinator
- `coordinator@self` = current repo's coordinator
- `coordinator@<repo>` = per-repo coordinator by repo name
- `<id>@<repo>` = agent by ID in named repo
- `<id>` alone = agent by ID in current repo
- Partial matching: allowed within the specified realm

**Session-start instructions:**

*Worker (in itsybitsy repo with manager = coordinator)*:
```
| `ib send coordinator@self "msg"` | Send to your manager (repo coordinator) |
| `ib send coordinator@system "msg"` | Send to system coordinator |
```

*Per-repo Coordinator*:
```
| `ib send coordinator@system "msg"` | Send to system coordinator |
| `ib send coordinator@muse-ios "msg"` | Coordinate with other repo |
```

**Pros:**
- Familiar format (like email addresses, DNS names)
- Clear separation: `agent@realm` is always "agent in realm"
- Realm is optional for local operations
- Good for LLM agents (explains easily as "email-style addressing")

**Cons:**
- `@` is special in shells (background, variable expansion) — requires quoting
- `coordinator@self` still needs CWD context
- Longer syntax for common cases
- More typing overall

---

### Scheme 3: Suffix-Based (`agent.repo`)

**Syntax for all 5 cases:**

```
1. Send to system coordinator
   ib send .coordinator "message"
   
2. Send to own repo's coordinator (from worker in itsybitsy repo)
   ib send .coordinator "message"
   (same as above; context is implicit)
   
3. Send to another repo's coordinator (from agent in muse-ios repo)
   ib send coordinator.itsybitsy "message"
   
4. Send to agent in another repo (from agent in muse-ios repo)
   ib send agent-a1b2c3d4.itsybitsy "message"
   
5. Send to agent in same repo (from agent in itsybitsy repo)
   ib send agent-a1b2c3d4 "message"
```

**Resolution rules:**
- `.coordinator` = system coordinator (dot prefix, special)
- `<name>.<repo>` = agent in named repo
- `<name>` = agent in current repo
- When `<name>` is `coordinator` and called from within a repo, treat as current repo's coordinator
- Partial matching: allowed on both sides of the dot if fully qualified

**Session-start instructions:**

*Worker*:
```
| `ib send .coordinator "msg"` | Send to system coordinator |
| `ib send manager-id "msg"` | Send to your manager |
```

*Per-repo Coordinator*:
```
| `ib send coordinator.itsybitsy "msg"` | Send to another repo's coordinator |
| `ib send .coordinator "msg"` | Send to system coordinator |
```

**Pros:**
- Minimal special characters (just `.` which is not shell-special)
- Short syntax for local operations (`agent-id` only)
- Familiar from domain names
- Less typing than other schemes

**Cons:**
- Leading dot (`.coordinator`) is unusual and might confuse users
- Requires understanding that bare `coordinator` is context-aware (coordinator when called from within repo vs system when not)
- Partial matching with `.` could break (`.coo` to match `.coordinator`?)
- When called outside agent context, how do we reach `coordinator.itsybitsy`? Via full name only? That's a special rule.

---

### Scheme 4: Explicit Prefix (`/system/`, `/repo/`, `/agent/`)

**Syntax for all 5 cases:**

```
1. Send to system coordinator
   ib send /system/coordinator "message"
   
2. Send to own repo's coordinator (from worker in itsybitsy repo)
   ib send /repo/coordinator "message"
   
3. Send to another repo's coordinator (from agent in muse-ios repo)
   ib send /repo/itsybitsy/coordinator "message"
   
4. Send to agent in another repo (from agent in muse-ios repo)
   ib send /repo/itsybitsy/agent-a1b2c3d4 "message"
   
5. Send to agent in same repo (from agent in itsybitsy repo)
   ib send /repo/agent-a1b2c3d4 "message"
   (or shortened: ib send /agent-a1b2c3d4 "message")
```

**Resolution rules:**
- `/system/coordinator` = system coordinator
- `/repo/coordinator` = current repo's coordinator (only from within a repo)
- `/repo/<name>/coordinator` = coordinator in named repo
- `/repo/<name>/<agent>` = agent in named repo
- `/repo/<agent>` = agent in current repo
- `/agent/<id>` = shorthand for `/repo/<id>` (current repo only)
- Partial matching: allowed within each path segment

**Session-start instructions:**

*Worker*:
```
| `ib send /repo/coordinator "msg"` | Send to your manager (repo coordinator) |
| `ib send /system/coordinator "msg"` | Send to system coordinator |
```

*Manager*:
```
| `ib send /repo/<agent-id> "msg"` | Send to agent in same repo |
| `ib send /repo/muse-ios/<agent-id> "msg"` | Send to agent in other repo |
```

**Pros:**
- Completely unambiguous: path structure is explicit
- No CWD context needed (fully qualified paths always work)
- Extensible: easy to add more namespaces later (`/tool/`, `/service/`, etc.)
- LLM-friendly: rules are very clear
- No shell-special characters (apart from `/` which is literal in quoted strings)

**Cons:**
- Verbose: extra typing for every command
- Unusual syntax (not like typical CLI tools)
- Longer strings = more room for typos
- `/repo/` prefix is redundant information (users know they're in a repo context)

---

### Scheme 5: Smart Inference (Current + Heuristics)

**Syntax for all 5 cases:**

```
1. Send to system coordinator
   ib send coordinator "message"
   (when called from non-repo context)
   
2. Send to own repo's coordinator (from worker in itsybitsy repo)
   ib send coordinator "message"
   (when called from within repo)
   
3. Send to another repo's coordinator (from agent in muse-ios repo)
   ib send itsybitsy "message"
   (repo name)
   
4. Send to agent in another repo (from agent in muse-ios repo)
   ib send muse-ios:agent-a1b2c3d4 "message"
   (repo name : agent id)
   
5. Send to agent in same repo (from agent in itsybitsy repo)
   ib send agent-a1b2c3d4 "message"
   (agent id only)
```

**Resolution rules:**
- Bare `coordinator`: context-aware
  - If called from within a repo → current repo's coordinator
  - If called from outside → system coordinator
- Bare repo name (matches `repos.json`) → per-repo coordinator
- `repo:agent` → agent in named repo
- Bare agent ID (prefix match allowed) → agent in current repo

**Session-start instructions:**

*Worker*:
```
| `ib send coordinator "msg"` | Send to your manager (repo coordinator) |
| `ib send @system "msg"` | Send to system coordinator (if needed) |
```

*Per-repo Coordinator*:
```
| `ib send coordinator "msg"` | Send to another repo's coordinator |
| (provide repo name instead of `coordinator` to reach other repos) |
```

**Pros:**
- Minimal typing for most cases
- Backward-compatible with existing behavior
- Works well for humans at the CLI
- Familiar (current system extended with heuristics)

**Cons:**
- **Ambiguous**: `coordinator` changes meaning based on CWD (context-dependent)
  - LLM agents will generate incorrect commands if they guess wrong about context
  - Debugging is hard: "why did my message go to system instead of repo?"
- Requires CWD detection at runtime (slower)
- Error-prone: silent failures if heuristics misfire
- Unclear what "repo name" means (how long is a prefix? `it` for `itsybitsy`?)
- Does not solve the original ambiguity problem

---

## Comparison Table

| Scheme | System Coord | Own Repo Coord | Other Repo Coord | Cross-Repo Agent | Same-Repo Agent | Shell-Safe | Typing | LLM-Friendly | Ambiguous |
|--------|--------------|----------------|------------------|------------------|-----------------|-----------|--------|--------------|-----------|
| 1. Path (repo:agent) | `@` | `@self` | `@repo` | `repo:agent` | `agent` | ✓ | Medium | ✓ | Low |
| 2. DNS (@) | `coordinator@system` | `coordinator@self` | `coordinator@repo` | `agent@repo` | `agent` | ✗ (@) | High | ✓ | Low |
| 3. Suffix (.) | `.coordinator` | `.coordinator` | `coordinator.repo` | `agent.repo` | `agent` | ✓ | Low | Medium | High |
| 4. Prefix (/) | `/system/coordinator` | `/repo/coordinator` | `/repo/repo/coordinator` | `/repo/repo/agent` | `/repo/agent` | ✓ | High | ✓ | None |
| 5. Smart (Current) | `coordinator` | `coordinator` | `repo` | `repo:agent` | `agent` | ✓ | Low | ✗ | **High** |

---

## Analysis: What if a repo name matches an agent name?

Example: repo named `agent` with coordinator agent ID `agent`, and a regular agent `agent-a1b2c3d4` in another repo.

### Scheme 1 (Path):
- `ib send agent` → agent in current repo (unambiguous in context)
- `ib send @agent` → repo named `agent`'s coordinator (clear)
- `ib send agent:agent-a1b2c3d4` → agent in `agent` repo (explicit)
- **No collision** ✓

### Scheme 2 (DNS):
- `ib send agent` → agent in current repo
- `ib send coordinator@agent` → coordinator in `agent` repo
- `ib send agent-a1b2c3d4@agent` → agent in `agent` repo
- **No collision** ✓

### Scheme 3 (Suffix):
- `ib send agent` → depends on context (risky)
- `ib send coordinator.agent` → coordinator in `agent` repo
- `ib send agent.agent` → could collide! Is it "agent named agent in current repo" or "agent in agent repo"?
- **Collision possible** ✗

### Scheme 4 (Prefix):
- `ib send /repo/agent` → agent in current repo (explicit)
- `ib send /repo/agent/coordinator` → coordinator in `agent` repo (explicit)
- `ib send /repo/agent/agent` → agent named `agent` in `agent` repo (explicit)
- **No collision** ✓

### Scheme 5 (Smart):
- `ib send agent` → agent in current repo OR coordinator in `agent` repo? (ambiguous!)
- `ib send coordinator` → which repo's coordinator? (depends on CWD)
- **Major collision risk** ✗✗

---

## LLM Agent Instructions per Scheme

### Scheme 1 (Path: `repo:agent`)

```markdown
### Addressing in Multi-Agent System

You are operating in a distributed itsybitsy system with multiple repos and agents.

**System Coordinator** (special, no repo)
- `ib send @ "msg"` — send to system coordinator

**Per-Repo Coordinators**
- `ib send @self "msg"` — send to current repo's coordinator
- `ib send @<repo-name> "msg"` — send to another repo's coordinator

**Agents in Your Repo**
- `ib send <agent-id> "msg"` — send to agent in same repo

**Agents in Other Repos**
- `ib send <repo>:<agent-id> "msg"` — send to agent in named repo

**Example**: You're working in `itsybitsy` repo. To send to `agent-a1b2c3d4` in `muse-ios`:
`ib send muse-ios:agent-a1b2c3d4 "Please review the refactoring"`

**Rule**: Prefix with `@` for coordinators (system or repo), use `:` to cross repos.
```

### Scheme 4 (Prefix: `/system/repo/agent`)

```markdown
### Addressing in Multi-Agent System

All addresses have an explicit path structure:

- `/system/coordinator` — the system coordinator
- `/repo/coordinator` — current repo's coordinator (only from within repo)
- `/repo/<repo-name>/coordinator` — another repo's coordinator
- `/repo/<repo-name>/<agent-id>` — agent in named repo
- `/repo/<agent-id>` — agent in current repo (shorthand)
- `/agent/<agent-id>` — agent in current repo (alternative shorthand)

Always use fully qualified paths when unsure (e.g., `/repo/muse-ios/agent-a1b2c3d4`).

Partial matching is supported on agent IDs and repo names.
```

---

## Recommendation

**Scheme 1 (Hierarchical Path: `repo:agent`)** is the best balance:

1. **Unambiguous addressing**: `@` for coordinators, `:` for cross-repo agents
2. **LLM-friendly**: Rules are simple and deterministic (no context inference)
3. **Backward-compatible**: bare `<agent-id>` still works for same-repo
4. **Low friction**: not verbose, shell-safe (no quoting needed)
5. **Extensible**: future schemes can build on this (e.g., `repo:worker:id` for future hierarchies)

**Second choice**: Scheme 4 (Prefix) for absolute clarity, at the cost of verbosity.

**Avoid**: Scheme 5 (Smart Inference) — the original problem is ambiguity; encoding context-dependent semantics makes it worse.

---

## Session-Start Instruction Templates

### For Scheme 1:

**Manager (top-level, in itsybitsy repo)**:
```
You can spawn worker sub-agents and coordinate across repos:
- `ib send <agent-id> "msg"` — message agent in same repo
- `ib send @self "msg"` — message your repo's coordinator (itsybitsy)
- `ib send @<other-repo> "msg"` — reach another repo's coordinator
- `ib send <other-repo>:<agent-id> "msg"` — reach agent in other repo

Example: `ib send @muse-ios "Can you start the login feature?"` to ask muse-ios's coordinator
```

**Worker (in itsybitsy repo, manager = itsybitsy coordinator)**:
```
You report to your manager via:
- `ib send itsybitsy "Progress update: completed auth module"`

To reach system coordinator: `ib send @ "Escalating blocker: ...")`
```

**Per-Repo Coordinator (itsybitsy)**:
```
Communicate with:
- `ib send <agent-id> "msg"` — message workers in your repo
- `ib send @ "msg"` — message system coordinator
- `ib send @<other-repo> "msg"` — coordinate with other repos' coordinators

Example: `ib send @ "itsybitsy coordinator ready, starting workers"`
```

---

## Next Steps

1. **Prototyping**: Implement Scheme 1 (`repo:agent` with `@` syntax) in `ib send` command
2. **Testing**: Verify no collisions with existing agent IDs and repo names
3. **Documentation**: Update SPEC.md §4.1 and §12.3.1 with new addressing rules
4. **Session-start injection**: Update `src/hooks/session-start.ts` to inject appropriate templates per role
5. **LLM instruction**: Update session-start blocks with new addressing examples
6. **Validation**: Add CLI input validation for `@`, `:` syntax (already done for agent IDs)

---

## Implementation Notes for Scheme 1

### Changes to `ib send` Resolution:

```typescript
// Current (flat prefix matching):
// ib send agent-a1 → finds agent-a1b2c3d4 (prefix match)

// New (hierarchical):
// Parse target:
if (target.startsWith('@')) {
  // Coordinator addressing: @, @self, @<repo>
  return resolveCoordinator(target);
} else if (target.includes(':')) {
  // Cross-repo: repo:agent
  const [repo, agent] = target.split(':');
  return resolveAgentInRepo(repo, agent);
} else {
  // Same-repo: agent only
  return resolveAgentInCurrentRepo(target);
}
```

### Validation Rules:

- `@` alone is valid (system coordinator)
- `@self` is valid only when called from within an agent worktree
- `@<repo>` must match a registered repo name (or prefix)
- `repo:agent` must have both parts; `repo` must be registered; `agent` must match an agent in that repo
- Bare `<agent>` uses standard prefix matching within current repo

### Edge Cases:

- `@agent` when there's a repo named `agent` → clearly the coordinator (`:` separates agent addresses)
- `agent:` (trailing colon) → invalid syntax, error
- `:agent` (leading colon) → equivalent to `agent` (current repo)
- `repo:` (no agent part) → reaches the per-repo coordinator? Or error? (Define: error, use `@repo`)

I HAVE COMPLETED THE GOAL